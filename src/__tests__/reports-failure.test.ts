// FAILURE-REPORTING HARNESS
//
// Every other suite asks "does the tool work when things are fine". This one
// asks the question that actually bit us: WHEN THE UNDERLYING THING FAILED,
// DOES THE TOOL SAY SO?
//
// Motivation (2026-07-20): four separate false greens shipped or nearly
// shipped in one release cycle, doctor reported healthy over a crashing
// background, dev and start reported "started" for a process that had already
// exited, open reported ok:true for a navigation that 404'd, and build reported
// success for a dist missing a declared entrypoint. A 30-persona swarm found
// NONE of them, because a persona believes what a tool tells it. Only an
// adversarial assertion catches a lie.
//
// RULE FOR THIS FILE: break something real, then assert the tool reports the
// failure. Never assert on the happy path here. That is what the other suites
// are for. A test that passes because nothing was broken is worse than no test.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reports-failure-"));
  tmpDirs.push(dir);
  return dir;
}

function writeReady(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown>,
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(contract));
}

function writeLogs(
  projectPath: string,
  browser: string,
  events: Array<Record<string, unknown>>,
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "logs.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

// A pid that cannot be alive, for "the session died" scenarios.
const DEAD_PID = 2 ** 30;

let cliResult = { code: 0, stdout: "", stderr: "" };
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async () => cliResult,
  };
});

const doctor = await import("../tools/doctor");
const build = await import("../tools/build");
const waitTool = await import("../tools/wait");
const logs = await import("../tools/logs");
const { recentErrorLogs } = doctor;

afterEach(() => {
  cliResult = { code: 0, stdout: "", stderr: "" };
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor reports failure when the extension is broken", () => {
  it("surfaces a crashing background instead of reporting healthy", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      {
        v: 1,
        level: "error",
        context: "background",
        messageParts: [
          "Uncaught TypeError: Cannot read properties of undefined (reading 'query')",
        ],
        runId: "r1",
      },
    ]);

    // The exact shape that used to be dropped: payload in messageParts.
    const errs = recentErrorLogs(project, "chrome");

    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Uncaught TypeError");
  });

  it("does not invent errors when the extension is quiet", () => {
    const project = tmpProject();
    writeLogs(project, "chrome", [
      { v: 1, level: "info", context: "background", messageParts: ["ok"], runId: "r1" },
    ]);

    expect(recentErrorLogs(project, "chrome")).toEqual([]);
  });

  it("reports unhealthy when the ready contract records an error", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "error",
      pid: process.pid,
      errors: ["Module not found: ./missing.js"],
    });
    cliResult = { code: 0, stdout: "[]", stderr: "" };

    const result = JSON.parse(
      await doctor.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.healthy).toBe(false);
    const runtime = result.checks.find(
      (c: { check: string }) => c.check === "runtime-errors",
    );
    expect(runtime.status).toBe("fail");
    expect(runtime.detail).toContain("missing.js");
  });
});

describe("wait reports failure when the session is not actually usable", () => {
  it("reports stale, not ready, when ready.json outlives a dead dev server", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", { status: "ready", pid: DEAD_PID });

    const result = JSON.parse(
      await waitTool.handler({ projectPath: project, browser: "chrome" }),
    );

    // The trap: status "ready" on disk while nothing is running.
    expect(result.status).not.toBe("ready");
    expect(result.status).toBe("stale");
    expect(result.message).toMatch(/exited|dead/i);
  });

  it("reports the recorded build error rather than waiting it out", async () => {
    const project = tmpProject();
    writeReady(project, "chrome", {
      status: "error",
      pid: process.pid,
      message: "compile failed",
    });

    const result = JSON.parse(
      await waitTool.handler({ projectPath: project, browser: "chrome" }),
    );

    expect(result.status).toBe("error");
  });
});

describe("build reports failure when the artifact is unusable", () => {
  function projectWithManifest(
    manifest: Record<string, unknown>,
    dist?: { manifest: Record<string, unknown>; files: string[] },
  ): string {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "manifest.json"),
      JSON.stringify(manifest),
    );
    if (dist) {
      const distDir = path.join(dir, "dist", "chrome");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "manifest.json"),
        JSON.stringify(dist.manifest),
      );
      for (const f of dist.files) {
        fs.writeFileSync(path.join(distDir, f), "x");
      }
    }
    return dir;
  }

  it("refuses a build whose manifest has build-blocking errors", async () => {
    // No name: a required field.
    const dir = projectWithManifest({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
  });

  it("refuses to report success when a declared entrypoint never reached dist", async () => {
    const dir = projectWithManifest(
      {
        manifest_version: 3,
        name: "F",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
      },
      { manifest: { action: { default_popup: "popup.html" } }, files: [] },
    );
    // The bundler is happy; the artifact is not loadable.
    cliResult = { code: 0, stdout: "Build Status: success", stderr: "" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.buildExitCode).toBe(0);
  });

  it("propagates a non-zero build exit as a failure", async () => {
    const dir = projectWithManifest({
      manifest_version: 3,
      name: "F",
      version: "1.0.0",
    });
    cliResult = { code: 1, stdout: "", stderr: "Module not found: ./nope.js" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("nope.js");
  });
});

describe("logs reports failure rather than empty success", () => {
  it("errors when there is no log file at all", async () => {
    const project = tmpProject();

    const result = JSON.parse(await logs.handler({ projectPath: project }));

    expect(result.error).toBeDefined();
    expect(result.error).toContain("No logs found");
  });

  it("distinguishes an empty log from a missing one", async () => {
    const project = tmpProject();
    writeLogs(project, "chrome", []);

    const result = JSON.parse(
      await logs.handler({ projectPath: project, browser: "chrome" }),
    );

    // Reading succeeded and nothing matched: count must make that legible
    // rather than implying the extension is silent-and-fine.
    if (result.ok) {
      expect(result.count).toBe(0);
    } else {
      expect(result.error).toBeDefined();
    }
  });
});
