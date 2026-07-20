import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The engine persists its BuildSummary (structured, ANSI-stripped bundler
// warnings) to dist/extension-js/<browser>/build-summary.json specifically so
// this tool stops scraping stdout (engine §73). These tests pin the consumer:
// a FRESH contract is surfaced as `buildWarnings`, a STALE one from an
// earlier build is ignored, and an engine that predates the contract simply
// yields no field, never an invented one.

let cliResult = { code: 0, stdout: "Build Status: success", stderr: "" };
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async () => cliResult,
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
  cliResult = { code: 0, stdout: "Build Status: success", stderr: "" };
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build consumes the engine's persisted BuildSummary", () => {
  it("surfaces fresh structured warnings as buildWarnings", async () => {
    const project = completeProject();
    // The handler stamps `start` before the CLI runs; a summary written during
    // the (mocked, instant) build must still count as fresh, so nudge the
    // mtime slightly into the future.
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

    expect(result.success).toBe(true);
    expect(result.buildWarnings).toEqual([
      "Deprecation: legacy API",
      "asset size limit exceeded",
    ]);
    expect(result.buildWarningsTruncated).toBeUndefined();
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

    // 20-cap honesty: "2 warnings shown" must not read as "2 warnings total".
    expect(result.buildWarnings).toEqual(["w1", "w2"]);
    expect(result.buildWarningsTruncated).toBe(23);
  });

  it("ignores a stale summary left by an earlier build", async () => {
    const project = completeProject();
    writeSummary(
      project,
      { browser: "chrome", warnings_count: 1, warnings: ["old warning"] },
      new Date(Date.now() - 60_000),
    );

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.success).toBe(true);
    expect(result.buildWarnings).toBeUndefined();
  });

  it("omits the field entirely on engines that predate the contract", async () => {
    const project = completeProject();

    const result = JSON.parse(await build.handler({ projectPath: project }));

    expect(result.success).toBe(true);
    expect(result.buildWarnings).toBeUndefined();
  });
});
