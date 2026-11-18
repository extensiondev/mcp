import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import { DEFAULT_SERVER_OPTIONS, setServerOptions } from "../lib/tool-policy";
import {
  browserFromCliArgs,
  buildNarration,
  preSummariesBuildFrame,
  writeEngineDist,
} from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";

let installNoise = "";

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      const browser = browserFromCliArgs(args);
      if (args[0] === "build") writeEngineDist(args[1]!, browser);

      return {
        code: 0,
        stdout: `${JSON.stringify(preSummariesBuildFrame(args[1]!, [browser]))}\n`,
        stderr: `${buildNarration(browser)}${installNoise}`,
      };
    },
  };
});

const build = await import("../tools/build");

const tmpDirs: string[] = [];

function completeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-summary-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
  );

  const distDir = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
  );

  return dir;
}

function writeSummary(
  project: string,
  summary: Record<string, unknown>,
  mtime?: Date,
): void {
  const dir = path.join(project, "dist", "extension-js", "chrome");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "build-summary.json");
  fs.writeFileSync(file, JSON.stringify(summary));
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build consumes the engine's persisted BuildSummary when the frame on stdout predates the summaries contract (value.summaries absent)", () => {
  it("surfaces fresh structured warnings as buildWarnings", async () => {
    const project = completeProject();
    writeSummary(
      project,
      {
        browser: "chrome",
        warnings_count: 2,
        warnings: ["Deprecation: legacy API", "asset size limit exceeded"],
      },
      new Date(Date.now() + 2000),
    );

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Deprecation: legacy API",
        "asset size limit exceeded",
      ]),
    );

    expect(result.value.buildWarningsTruncated).toBeUndefined();
  });

  it("names the true count when the engine capped the list", async () => {
    const project = completeProject();
    writeSummary(
      project,
      {
        browser: "chrome",
        warnings_count: 23,
        warnings: ["w1", "w2"],
      },
      new Date(Date.now() + 2000),
    );

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.warnings).toEqual(expect.arrayContaining(["w1", "w2"]));
    expect(result.value.buildWarningsTruncated).toBe(23);
  });

  it("ignores a stale summary left by an earlier build", async () => {
    const project = completeProject();
    writeSummary(
      project,
      { browser: "chrome", warnings_count: 1, warnings: ["old warning"] },
      new Date(Date.now() - 60_000),
    );

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.warnings).not.toContain("old warning");
  });

  it("omits the field entirely on engines that predate the contract", async () => {
    const project = completeProject();

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.value.buildWarningsTruncated).toBeUndefined();
  });

  it("hands the reading of the build to extension_analyze, with the projectPath and browser it takes", async () => {
    const project = completeProject();

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.hint).toMatch(/call extension_analyze with this projectPath and browser "chrome"/);
    expect(result.hint).toMatch(/sizes, entry points, store checks/);
    expect(result.hint).toMatch(/instead of listing or grepping the folder/);
    expect(result.hint).toMatch(/each built browser's emitted manifest in manifestByBrowser/);
    expect(result.hint).toContain(result.value.outputPath);
  });

  it("names the folder it read as outputPath even when the engine reported no summary", async () => {
    const project = completeProject();

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.value.outputPath).toBe(path.join(project, "dist", "chrome"));
  });

  it("916: with no summary to read, the output tail is the engine's own lines, with no npm notice and no blank line", async () => {
    installNoise = "npm notice\nnpm notice New minor version of npm available! 11.6.0 -> 11.7.0\nnpm notice To update run: npm install -g npm@11.7.0\nnpm warn deprecated glob@7.2.3\n\n";

    try {
      const result = JSON.parse(await build.handler({ projectPath: completeProject() }));
      const lines: string[] = result.value.output.split("\n");

      expect(result.ok).toBe(true);
      expect(lines[lines.length - 1]).toBe("⏵⏵⏵ Extension built for production in dist/chrome (165 B).");
      expect(lines.filter((line) => line.trim() === "" || /^npm (notice|warn)/.test(line))).toEqual([]);
    } finally {
      installNoise = "";
    }
  });

  it.each([
    [["local", "platform"], true],
    [["local"], false],
  ] as const)("with features %j, the success hint names extension_publish as the way to send the build: %s", async (features, named) => {
    setServerOptions({ features: [...features], noShip: false });

    try {
      const result = JSON.parse(await build.handler({ projectPath: completeProject() }));

      expect(result.ok).toBe(true);
      expect(result.hint.includes("extension_publish gives the project's build on extension.dev a page with a download and a run command for each browser")).toBe(named);
    } finally {
      setServerOptions(DEFAULT_SERVER_OPTIONS);
    }
  });

  it("ledger 541: the platform sentence names rebuild as the push-free way to the platform build, never a pushed source", async () => {
    setServerOptions({ features: ["local", "platform"], noShip: false });

    try {
      const result = JSON.parse(await build.handler({ projectPath: completeProject() }));

      expect(result.ok).toBe(true);
      expect(result.hint).toContain('the platform builds the source it holds, not this folder: extension_builds_act action:"rebuild" starts that build with no push');
      expect(result.hint).not.toContain("pushed source");
    } finally {
      setServerOptions(DEFAULT_SERVER_OPTIONS);
    }
  });
});
