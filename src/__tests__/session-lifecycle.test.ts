import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";


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

const dev = await import("../tools/dev");
const stop = await import("../tools/stop");
const { registerSession, removeSession, listSessionMarkers } = await import(
  "../lib/process-manager"
);

function spawnVictim(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  spawned.push(child);
  return child.pid!;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeReadyContract(
  project: string,
  browser: string,
  pid: number,
): void {
  const dir = path.join(project, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({ status: "ready", command: "dev", browser, pid }),
  );
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

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-life-"));
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

describe("extension_dev fork guard", () => {
  it("refuses a second dev call while a live session holds the project", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("session-exists");
    expect(result.error.code).toBe("E_SESSION_EXISTS");
    expect(result.value.sessions).toEqual([{ pid, browser: "chrome" }]);
    expect(result.hint).toContain("replace: true");
    expect(result.hint).toContain("extension_stop");
    expect(isAlive(pid)).toBe(true);
  });

  it("also sees a live session recorded only in the ready.json contract", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    writeReadyContract(project, "chrome", pid);

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("session-exists");
    expect(result.value.sessions[0].pid).toBe(pid);
  });

  it("replace:true stops the old session and reports it as replacedSession", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(
      await dev.handler({ projectPath: project, replace: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.value.replacedSession).toEqual({ pid, browser: "chrome" });
    expect(isAlive(pid)).toBe(false);
  }, 20_000);
});

describe("extension_dev browser leg health", () => {
  it("reports ok:false when the browser died behind a surviving dev server", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli("setTimeout(()=>{}, 60000)");
      setTimeout(() => stampBrowserExited(project, "chrome"), 1000);
      return cli;
    };

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("browser-exited");
    expect(result.error.code).toBe("E_BROWSER_EXITED");
    expect(result.value.browserExitCode).toBe(1);
    expect(result.error.message).toContain("browser");
    expect(result.hint).toContain(
      path.join(project, "dist", "extension-profile-chrome"),
    );
  }, 15_000);

  it("splits a profile lock out of browser-exited, even on engines without the stamp", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("Failed to create a ProcessSingleton for your profile directory"); setTimeout(()=>{}, 60000);',
      );

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("profile-locked");
    expect(result.error.code).toBe("E_PROFILE_LOCKED");
    expect(result.error.message).toContain("profile is locked");
    expect(result.hint).toContain("extension-profile-chrome");
    // No contract said so, so the degraded read is disclosed.
    expect(result.warnings.join(" ")).toContain("machine contract");
  }, 15_000);
});

describe("extension_stop all:true discovery", () => {
  it("finds a live session through on-disk markers after registry amnesia", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    writeReadyContract(project, "chrome", pid);
    removeSession(project, "chrome");

    const result = JSON.parse(await stop.handler({ all: true }));

    expect(result.status).toBe("stopped-all");
    const mine = result.value.stopped.find(
      (o: { projectPath: string }) => path.resolve(o.projectPath) === project,
    );
    expect(mine).toBeDefined();
    expect(mine.pid).toBe(pid);
    expect(mine.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
    const remaining = listSessionMarkers().map((m) =>
      path.resolve(m.projectPath),
    );
    expect(remaining).not.toContain(project);
  }, 20_000);

  it("says so honestly when neither registry nor markers know a session", async () => {
    for (const m of listSessionMarkers()) {
      await stop.handler({ projectPath: m.projectPath, browser: m.browser, all: false });
    }
    const result = JSON.parse(await stop.handler({ all: true }));
    expect(result.value.stopped).toEqual([]);
    expect(result.status).toBe("nothing-to-stop");
    expect(result.hint).toContain("no session markers");
  }, 30_000);
});
