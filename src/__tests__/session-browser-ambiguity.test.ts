import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";

const cliCalls: string[][] = [];

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);


      return { code: 1, stdout: "", stderr: "the engine was reached" };
    },
    spawnExtensionCli: (args: string[]) => {
      cliCalls.push(args);

      throw new Error("the engine was spawned");
    },
  };
});

const { registerSession, removeSession, removeSessionMarker } = await import(
  "../lib/process-manager"
);

const TOOLS: Array<[string, () => Promise<{ handler: (args: any) => Promise<string> }>, Record<string, unknown>]> = [
  ["extension_inspect", () => import("../tools/inspect"), {}],
  ["extension_wait", () => import("../tools/wait"), { timeoutMs: 200 }],
  ["extension_eval", () => import("../tools/eval"), { expression: "1" }],
  ["extension_storage", () => import("../tools/storage"), { action: "get" }],
  ["extension_reload", () => import("../tools/reload"), {}],
  ["extension_open", () => import("../tools/open"), { surface: "popup" }],
  ["extension_dom_snapshot", () => import("../tools/dom-snapshot"), {}],
  ["extension_list_extensions", () => import("../tools/list-extensions"), {}],
  ["extension_assert", () => import("../tools/assert"), { expect: [{ assert: "background-worker-booted" }] }],
  ["extension_logs", () => import("../tools/logs"), {}],
  ["extension_stop", () => import("../tools/stop"), {}],
  ["extension_doctor", () => import("../tools/doctor"), {}],
];

const spawned: ChildProcess[] = [];
const tmpDirs: string[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;

function spawnServer(): number {
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

function projectWithTwoSessions(): { project: string; chromePid: number; firefoxPid: number } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-two-sessions-"));
  tmpDirs.push(project);
  const chromePid = spawnServer();
  const firefoxPid = spawnServer();
  registerSession({ pid: chromePid, browser: "chrome", projectPath: project, command: "dev" });
  registerSession({ pid: firefoxPid, browser: "firefox", projectPath: project, command: "start" });

  return { project, chromePid, firefoxPid };
}

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-two-sessions-xdg-"));
  vi.stubGlobal("fetch", async () => {
    throw new Error("network is stubbed in this suite");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();

  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;

  else process.env.XDG_CONFIG_HOME = savedXdg;
});

afterEach(() => {
  cliCalls.length = 0;

  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    for (const browser of ["chrome", "firefox"]) {
      removeSession(dir, browser);
      removeSessionMarker(dir, browser);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("a session tool without browser on a project that runs two sessions", () => {
  it.each(TOOLS)("%s asks for browser instead of picking one", async (_name, load, extra) => {
    const { project, chromePid, firefoxPid } = projectWithTwoSessions();
    const tool = await load();

    const result = JSON.parse(await tool.handler({ projectPath: project, ...extra }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("browser-required");
    expect(result.error.code).toBe("E_SESSION_AMBIGUOUS");
    expect(result.value.sessions).toEqual(
      expect.arrayContaining([
        { pid: chromePid, browser: "chrome" },
        { pid: firefoxPid, browser: "firefox" },
      ]),
    );

    expect(result.hint).toContain("browser");
    expect(cliCalls).toEqual([]);
    expect(isAlive(chromePid)).toBe(true);
    expect(isAlive(firefoxPid)).toBe(true);
  }, 20_000);

  it("goes on to the named session when browser is given", async () => {
    const { project } = projectWithTwoSessions();
    const wait = await import("../tools/wait");

    const result = JSON.parse(
      await wait.handler({ projectPath: project, browser: "firefox", timeoutMs: 200 }),
    );

    expect(result.status).not.toBe("browser-required");
  }, 20_000);
});
