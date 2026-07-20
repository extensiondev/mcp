import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Stand in for the extension CLI: `node -e <script>` gives a real child process
// with real exit semantics, so the health tick is exercised end to end rather
// than against a hand-rolled EventEmitter.
const spawned: ChildProcess[] = [];
function fakeCli(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  return child;
}

let nextChild: () => ChildProcess = () => fakeCli("setTimeout(()=>{}, 60000)");

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    spawnExtensionCli: () => nextChild(),
  };
});

const dev = await import("../tools/dev");
const start = await import("../tools/start");
const { removeSession } = await import("../lib/process-manager");

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-health-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
      // no session registered
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev health tick", () => {
  it("reports the death instead of status:started when the server exits on boot", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.error("Error: listen EADDRINUSE: address already in use :::8080"); process.exit(1);',
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("exited during startup");
    // The child's own output is the evidence a caller needs to fix it.
    expect(result.output).toContain("EADDRINUSE");
  }, 15_000);

  it("surfaces a signalled death", async () => {
    const project = tmpProject();
    nextChild = () => fakeCli("process.kill(process.pid, 'SIGKILL')");

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.signal).toBe("SIGKILL");
  }, 15_000);

  // extension_start had the identical defect, found by sweeping for the pattern
  // after the dev.ts fix rather than by hitting it.
  it("applies to extension_start too", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.error("build failed: missing dependency"); process.exit(1);');

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.output).toContain("build failed");
  }, 20_000);

  // L5 from the API-surface swarm: a FAILED FIRST COMPILE leaves the dev server
  // alive, so the process health tick cannot see it. Three personas were told
  // status:"started" with the error buried in earlyOutput.
  it("reports a failed first compile even though the server is alive", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("\\u2716\\u2716\\u2716 Probe compiled with errors in 180 ms. ERROR in ./src/panel.js NOT FOUND"); setTimeout(()=>{}, 60000);',
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compile-failed");
    expect(result.output).toContain("compiled with errors");
    expect(result.hint).toContain("extension_wait");
  }, 20_000);

  it("still reports started for a server that survives the tick", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.browser).toBe("chrome");
    expect(result.earlyOutput).toContain("ready in 300ms");
  }, 15_000);
});
