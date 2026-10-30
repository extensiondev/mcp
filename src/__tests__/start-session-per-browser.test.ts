// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";

const spawned: ChildProcess[] = [];
const spawnedArgs: string[][] = [];

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
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

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: (args: string[]) => {
      spawnedArgs.push(args);

      return fakeCli();
    },
  };
});

vi.mock("../lib/boot-verdict", () => ({
  pollBootVerdict: async () => ({ verdict: { kind: "started" }, warnings: [], evidenceTail: "" }),
  bootFailureHint: () => "",
}));

const start = await import("../tools/start");
const { registerSession, removeSession, removeSessionMarker, findSessionInfo } = await import(
  "../lib/process-manager"
);

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-per-browser-"));
  tmpDirs.push(dir);

  return dir;
}

function liveDevServer(): number {
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

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  spawnedArgs.length = 0;

  for (const dir of tmpDirs.splice(0)) {
    for (const browser of ["chrome", "firefox"]) {
      const info = findSessionInfo(dir, browser);
      removeSession(dir, browser);
      if (info) removeSessionMarker(dir, browser, info.pid);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_start keeps one session per browser on a project", () => {
  it("refuses a start for the browser a live dev session runs, and leaves that session registered", async () => {
    const project = tmpProject();
    const devPid = liveDevServer();
    registerSession({ pid: devPid, browser: "firefox", projectPath: project, command: "dev" });

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project, browser: "firefox" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("session-exists");
    expect(result.error.code).toBe("E_SESSION_EXISTS");
    expect(result.error.message).toContain("dist/firefox");
    expect(result.value.sessions).toEqual([{ pid: devPid, browser: "firefox" }]);
    expect(result.hint).toContain('browser: "firefox"');
    expect(spawnedArgs).toHaveLength(0);
    expect(findSessionInfo(project, "firefox")?.pid).toBe(devPid);
    expect(isAlive(devPid)).toBe(true);
  });

  it("starts beside a live session of another browser without touching it", async () => {
    const project = tmpProject();
    const devPid = liveDevServer();
    registerSession({ pid: devPid, browser: "chrome", projectPath: project, command: "dev" });

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project, browser: "firefox" }));

    expect(result.status).toBe("started");
    expect(spawnedArgs).toHaveLength(1);
    expect(findSessionInfo(project, "chrome")?.pid).toBe(devPid);
    expect(isAlive(devPid)).toBe(true);
  });

  it("replace:true stops only that browser's session before starting", async () => {
    const project = tmpProject();
    const firefoxPid = liveDevServer();
    const chromePid = liveDevServer();
    registerSession({ pid: firefoxPid, browser: "firefox", projectPath: project, command: "dev" });
    registerSession({ pid: chromePid, browser: "chrome", projectPath: project, command: "dev" });

    const result = JSON.parse(
      await start.handler({ wait: false, projectPath: project, browser: "firefox", replace: true }),
    );

    expect(result.status).toBe("started");
    expect(result.value.replacedSession).toEqual({ pid: firefoxPid, browser: "firefox" });
    expect(isAlive(firefoxPid)).toBe(false);
    expect(isAlive(chromePid)).toBe(true);
    expect(findSessionInfo(project, "chrome")?.pid).toBe(chromePid);
  }, 20_000);
});
