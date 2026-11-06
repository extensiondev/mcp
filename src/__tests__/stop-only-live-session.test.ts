// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawn } from "node:child_process";
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
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-only-live-"));
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
const victims: number[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-only-live-project-"));
  tmpDirs.push(dir);

  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function register(projectPath: string, browser: string, command: ProcessInfo["command"] = "dev"): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  victims.push(pid);
  registerSession({ pid, browser, projectPath, command });

  return pid;
}

afterEach(() => {
  for (const s of listSessions()) {
    removeSession(s.projectPath, s.browser);
    removeSessionMarker(s.projectPath, s.browser);
  }

  for (const pid of victims.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_stop with no projectPath stops the only live session (ledger 438)", () => {
  it("stops the one live session and names its projectPath, browser and pid", async () => {
    const handsFree = tmpProject();
    const pid = register(handsFree, "chrome");

    const result = JSON.parse(await stop.handler({}));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("stopped");
    expect(result.error).toBeNull();
    expect(result.value.projectPath).toBe(handsFree);
    expect(result.value.browser).toBe("chrome");
    expect(result.value.pid).toBe(pid);
    expect(result.value.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(listSessions()).toHaveLength(0);
  }, 20_000);

  it("refuses with every live project under value.sessions when two projects are live and stops nothing", async () => {
    const leon = tmpProject();
    const rebeccat = tmpProject();
    const firefox = register(leon, "firefox");
    const chrome = register(rebeccat, "chrome", "start");

    const result = JSON.parse(await stop.handler({}));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.error.message).toContain("projectPath is required because sessions for 2 projects are live");
    expect(result.value.sessions).toEqual([
      { projectPath: leon, sessions: [{ browser: "firefox", pid: firefox, mode: "dev" }] },
      { projectPath: rebeccat, sessions: [{ browser: "chrome", pid: chrome, mode: "start" }] },
    ]);

    expect(result.value.confirm).toBeUndefined();
    expect(result.value.wouldStop).toBeUndefined();
    expect(result.hint).toContain("Nothing was stopped");
    expect(result.hint).toContain(leon);
    expect(result.hint).toContain(rebeccat);
    expect(isAlive(firefox)).toBe(true);
    expect(isAlive(chrome)).toBe(true);
    expect(listSessions()).toHaveLength(2);
  });

  it("answers no-session with an empty registry instead of asking for a projectPath", async () => {
    const result = JSON.parse(await stop.handler({}));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("no-session");
    expect(result.error.code).toBe("E_NO_SESSION");
    expect(result.value.sessions).toEqual([]);
    expect(result.hint).toContain("Nothing was stopped");
    expect(result.value.trackUrl).toMatch(/^https?:\/\//);
  });

  it("keeps the browser-required refusal when the only live project runs two browsers", async () => {
    const leon = tmpProject();
    const firefox = register(leon, "firefox");
    const chrome = register(leon, "chrome");

    const result = JSON.parse(await stop.handler({}));

    expect(result.status).toBe("browser-required");
    expect(result.error.code).toBe("E_SESSION_AMBIGUOUS");
    expect(result.value.projectPath).toBe(leon);
    expect(isAlive(firefox)).toBe(true);
    expect(isAlive(chrome)).toBe(true);
  });
});
