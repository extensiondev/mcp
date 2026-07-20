import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Stand in for the extension CLI: `node -e <script>` gives a real child process
// with real exit semantics, so the health tick is exercised end to end rather
// than against a hand-rolled EventEmitter. Mirrors the real spawnExtensionCli
// contract: output goes to a log file, not pipes (the detach-outlives-stdio
// design), and the handle exposes readOutput().
type SpawnedCli = import("../lib/exec").SpawnedCli;
const spawned: ChildProcess[] = [];
function fakeCli(script: string): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);
  return {
    child,
    logPath,
    readOutput: () => {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

let nextChild: () => SpawnedCli = () => fakeCli("setTimeout(()=>{}, 60000)");

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    spawnExtensionCli: () => nextChild(),
  };
});

const preview = await import("../tools/preview");
const start = await import("../tools/start");
const { removeSession } = await import("../lib/process-manager");

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-health-"));
  tmpDirs.push(dir);
  return dir;
}

function stampBrowserExited(project: string, browser: string): void {
  const dir = path.join(project, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({
      status: "error",
      code: "browser_exited",
      browserExitCode: 1,
      browserExitedAt: new Date().toISOString(),
    }),
  );
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

// Persona D19 (bug 72): {pid, status:'launched'} was returned for a process
// that died within seconds. The response shape is ours, so the fix is ours:
// liveness-tick before claiming launched, and read the engine's
// browser_exited stamp.
describe("extension_preview health tick", () => {
  it("reports the death instead of status:launched when the process exits on boot", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.error("Error: no production build found in dist/"); process.exit(1);',
      );

    const result = JSON.parse(await preview.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no production build");
    expect(result.hint).toContain("extension_build");
  }, 15_000);

  it("reports browser-exited when the CLI survives but ready.json carries the browser_exited stamp", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli("setTimeout(()=>{}, 60000)");
      // The engine stamps AFTER launch; write it while the tick is waiting so
      // the stamp is newer than the spawn, as it would be live.
      setTimeout(() => stampBrowserExited(project, "chrome"), 1000);
      return cli;
    };

    const result = JSON.parse(await preview.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("browser-exited");
    expect(result.code).toBe("browser_exited");
    expect(result.error).toContain("browser it launched has exited");
  }, 15_000);

  it("ignores a STALE browser_exited stamp from a previous run", async () => {
    const project = tmpProject();
    // Stamp BEFORE the spawn: a leftover from an earlier dead session must not
    // condemn a fresh launch.
    stampBrowserExited(project, "chrome");
    const past = Date.now() - 60_000;
    const readyPath = path.join(
      project,
      "dist",
      "extension-js",
      "chrome",
      "ready.json",
    );
    fs.utimesSync(readyPath, new Date(past), new Date(past));
    nextChild = () =>
      fakeCli('console.log("preview up"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(await preview.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("launched");
  }, 15_000);

  it("still reports launched for a process that survives the tick", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("previewing dist/chrome"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(await preview.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("launched");
    expect(result.earlyOutput).toContain("previewing dist/chrome");
  }, 15_000);

  it("extension_start reads the browser_exited stamp too", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli("setTimeout(()=>{}, 60000)");
      setTimeout(() => stampBrowserExited(project, "chrome"), 1000);
      return cli;
    };

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("browser-exited");
  }, 20_000);
});
