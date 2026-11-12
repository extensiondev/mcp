// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, afterAll } from "vitest";

import * as stop from "../tools/stop";
import {
  listSessions,
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";

import type { ProcessInfo } from "../lib/types";

const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-confirm-"));
process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;

afterAll(() => {
  if (previousSessionDir === undefined) {
    delete process.env.EXTENSION_MCP_SESSION_DIR;
  } else {
    process.env.EXTENSION_MCP_SESSION_DIR = previousSessionDir;
  }

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

const tmpDirs: string[] = [];
const victims = new Map<number, ChildProcess>();

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-confirm-project-"));
  tmpDirs.push(dir);

  return dir;
}

function victim(pid: number): ChildProcess {
  const child = victims.get(pid);
  if (!child) throw new Error(`pid ${pid} was not spawned by this file`);

  return child;
}

function isAlive(pid: number): boolean {
  const child = victim(pid);

  return child.exitCode === null && child.signalCode === null;
}

async function gone(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  return !isAlive(pid);
}

function register(projectPath: string, browser: string, command: ProcessInfo["command"] = "dev"): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  victims.set(pid, child);
  registerSession({ pid, browser, projectPath, command });

  return pid;
}

afterEach(() => {
  for (const s of listSessions()) {
    removeSession(s.projectPath, s.browser);
    removeSessionMarker(s.projectPath, s.browser);
  }

  for (const child of victims.values()) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  victims.clear();

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const stoppedPids = (result: any): number[] => result.value.stopped.map((o: { pid: number }) => o.pid);

describe("extension_stop all: true asks before it crosses projects", () => {
  it("answers confirm-required with both projects and stops nothing when the sessions span two projects", async () => {
    const leon = tmpProject();
    const rebeccat = tmpProject();
    const firefox = register(leon, "firefox");
    const chrome = register(rebeccat, "chrome", "start");

    const result = JSON.parse(await stop.handler({ all: true }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("confirm-required");
    expect(result.error).toBeNull();
    expect(result.value.wouldStop).toEqual([
      { projectPath: leon, sessions: [{ browser: "firefox", pid: firefox, mode: "dev" }] },
      { projectPath: rebeccat, sessions: [{ browser: "chrome", pid: chrome, mode: "start" }] },
    ]);

    expect(result.value.foreign).toEqual([]);
    expect(result.value.sayToPerson).toBe(
      `This would stop 2 sessions across 2 projects: ${leon}: firefox pid ${firefox} (dev); ${rebeccat}: chrome pid ${chrome} (start). Say stop again with confirm: true to end them all, or name projectPath to stop one project.`,
    );

    expect(result.value.trackUrl).toMatch(/^https?:\/\//);
    expect(result.hint).toContain("Nothing was stopped");
    expect(isAlive(firefox)).toBe(true);
    expect(isAlive(chrome)).toBe(true);
    expect(listSessions()).toHaveLength(2);
  });

  it("ends them all and answers stopped-all when the same call carries confirm: true", async () => {
    const leon = tmpProject();
    const rebeccat = tmpProject();
    const firefox = register(leon, "firefox");
    const chrome = register(rebeccat, "chrome");

    const result = JSON.parse(await stop.handler({ all: true, confirm: true }));

    expect(result.status).toBe("stopped-all");
    expect(result.ok).toBe(true);
    expect(stoppedPids(result).sort()).toEqual([firefox, chrome].sort());
    expect(result.value.trackUrl).toMatch(/^https?:\/\//);
    expect(await gone(firefox)).toBe(true);
    expect(await gone(chrome)).toBe(true);
    expect(listSessions()).toHaveLength(0);
  }, 20_000);

  it("stops one project's sessions with no confirmation when projectPath scopes it", async () => {
    const leon = tmpProject();
    const rebeccat = tmpProject();
    const leonFirefox = register(leon, "firefox");
    const leonChrome = register(leon, "chrome");
    const rebeccatChrome = register(rebeccat, "chrome");

    const result = JSON.parse(await stop.handler({ all: true, projectPath: leon }));

    expect(result.status).toBe("stopped-all");
    expect(result.ok).toBe(true);
    expect(stoppedPids(result).sort()).toEqual([leonFirefox, leonChrome].sort());
    expect(await gone(leonFirefox)).toBe(true);
    expect(await gone(leonChrome)).toBe(true);
    expect(isAlive(rebeccatChrome)).toBe(true);
    expect(listSessions().map((s) => s.pid)).toEqual([rebeccatChrome]);
  }, 20_000);

  it("needs no confirmation when every session belongs to one project", async () => {
    const leon = tmpProject();
    const firefox = register(leon, "firefox");
    const chrome = register(leon, "chrome");

    const result = JSON.parse(await stop.handler({ all: true }));

    expect(result.status).toBe("stopped-all");
    expect(result.ok).toBe(true);
    expect(stoppedPids(result).sort()).toEqual([firefox, chrome].sort());
    expect(await gone(firefox)).toBe(true);
    expect(await gone(chrome)).toBe(true);
  }, 20_000);

  it("never lists a session another running server owns under wouldStop", async () => {
    const leon = tmpProject();
    const rebeccat = tmpProject();
    const other = tmpProject();
    register(leon, "firefox");
    register(rebeccat, "chrome");
    const foreignMarker = path.join(sessionDir, "foreign.json");
    fs.writeFileSync(
      foreignMarker,
      JSON.stringify({ pid: 999_999, browser: "safari", projectPath: other, command: "dev", serverPid: process.ppid, registeredAt: new Date().toISOString() }),
    );

    try {
      const result = JSON.parse(await stop.handler({ all: true }));

      expect(result.status).toBe("confirm-required");
      expect(result.value.wouldStop.map((g: { projectPath: string }) => g.projectPath)).toEqual([leon, rebeccat]);
      expect(result.value.foreign).toEqual([{ projectPath: other, browser: "safari", serverPid: process.ppid }]);
      expect(result.value.sayToPerson).not.toContain(other);
    } finally {
      fs.rmSync(foreignMarker, { force: true });
    }
  });
});
