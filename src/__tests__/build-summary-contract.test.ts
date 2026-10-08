import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  browserFromCliArgs,
  buildNarration,
  preSummariesBuildFrame,
  writeEngineDist,
} from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";

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
        stderr: buildNarration(browser),
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
    expect(result.hint).toMatch(/sizes, the entry points and the store checks/);
    expect(result.hint).toMatch(/no need to list or grep the folder by hand/);
    expect(result.hint).toContain(result.value.outputPath);
  });

  it("names the folder it read as outputPath even when the engine reported no summary", async () => {
    const project = completeProject();

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.value.outputPath).toBe(path.join(project, "dist", "chrome"));
  });
});
