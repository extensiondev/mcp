import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const taskkillCalls: string[][] = [];
const windowsHost: { table: string | null } = { table: null };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = ((file: string, args?: readonly string[], options?: unknown) => {
    if (process.platform === "win32" && (file === "pgrep" || file === "ps")) {
      throw Object.assign(new Error(`spawnSync ${file} ENOENT`), { code: "ENOENT" });
    }
    if (file === "powershell") {
      if (windowsHost.table === null) {
        throw Object.assign(new Error("spawnSync powershell ENOENT"), { code: "ENOENT" });
      }
      return windowsHost.table;
    }
    if (file === "tasklist") {
      const pid = String(args?.[1] ?? "").replace("PID eq ", "");
      return `"node.exe","${pid}","Console","1","10,000 K"\r\n`;
    }
    if (file === "taskkill") {
      taskkillCalls.push([...(args ?? [])]);
      const pid = Number(args?.[1]);
      process.kill(pid, "SIGKILL");
      return Buffer.from("");
    }
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
  }) as typeof actual.execFileSync;
  return { ...actual, execFileSync, default: { ...actual, execFileSync } };
});

import { spawn } from "node:child_process";
import * as stop from "../tools/stop";
import * as releasePromote from "../tools/release-promote";
import { registerSession, removeSession } from "../lib/process-manager";
import { runCli } from "../index";

const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave6-markers-"));
process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wave6-"));
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

function spawnHolder(args: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid!;
}

const realKill = process.kill.bind(process);
const posixOnly = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  vi.restoreAllMocks();
  windowsHost.table = null;
  process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (previousSessionDir === undefined) delete process.env.EXTENSION_MCP_SESSION_DIR;
  else process.env.EXTENSION_MCP_SESSION_DIR = previousSessionDir;
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe("Reaped means confirmed gone", () => {
  posixOnly(
    "reports a holder that survived the kill apart from the reaped list",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnHolder([
        path.join(projectPath, "dist", "extension-js", "profiles", "chrome-profile", "calm-red-fox"),
      ]);
      await new Promise((r) => setTimeout(r, 200));
      vi.spyOn(process, "kill").mockImplementation(((target: number, sig?: string | number) => {
        if (sig === "SIGKILL") return true;
        return realKill(target, sig as NodeJS.Signals);
      }) as typeof process.kill);

      try {
        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));
        expect(result.value.reaped).not.toContain(pid);
        expect(result.value.reapUnconfirmed).toContain(pid);
        expect(result.value.stopped).toBe(false);
        expect(result.value.detail).toContain("still report alive");
      } finally {
        vi.restoreAllMocks();
        realKill(pid, "SIGKILL");
      }
    },
    15_000,
  );

  posixOnly(
    "ends a Windows session through taskkill /T /F, not the shim pid alone",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnHolder([]);
      registerSession({ pid, browser: "chrome", projectPath, command: "dev" });
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      taskkillCalls.length = 0;
      try {
        await stop.handler({ projectPath, browser: "chrome" });
      } finally {
        Object.defineProperty(process, "platform", platform);
        removeSession(projectPath, "chrome");
        if (isAlive(pid)) realKill(pid, "SIGKILL");
      }
      expect(taskkillCalls).toContainEqual(["/PID", String(pid), "/T", "/F"]);
    },
    15_000,
  );
});

/* @invariant Windows stop reads its own process table.
   pgrep and ps fail here as they do on Windows, so a pass cannot come from
   the host's own pgrep; powershell and tasklist answer from the table each
   cell sets, and taskkill really kills the holder. */
describe("A Windows stop can verify what it ended", () => {
  function onWindows<T>(run: () => Promise<T>): Promise<T> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    return run().finally(() => Object.defineProperty(process, "platform", platform));
  }

  posixOnly(
    "reaps a profile holder found in the process table and confirms it gone",
    async () => {
      const projectPath = tmpProject();
      const profileArg = path.join(projectPath, "dist", "extension-js", "profiles", "chrome-profile", "calm-red-fox");
      const pid = spawnHolder([profileArg]);
      await new Promise((r) => setTimeout(r, 200));
      windowsHost.table = `4\tSystem\t\r\n${pid}\tnode.exe\t"node" -e "x" ${profileArg}\r\n`;
      try {
        const result = JSON.parse(await onWindows(() => stop.handler({ projectPath, browser: "chrome" })));
        expect(result.value.reaped).toContain(pid);
        expect(result.value.stopped).toBe(true);
        expect(result.value.survivorsUnverified).toBeUndefined();
      } finally {
        if (isAlive(pid)) realKill(pid, "SIGKILL");
      }
    },
    15_000,
  );

  posixOnly(
    "answers stopped when the table shows nothing of the session left",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnHolder([]);
      registerSession({ pid, browser: "chrome", projectPath, command: "dev" });
      windowsHost.table = "4\tSystem\t\r\n";
      try {
        const result = JSON.parse(await onWindows(() => stop.handler({ projectPath, browser: "chrome" })));
        expect(result.value.stopped).toBe(true);
        expect(result.value.survivorsUnverified).toBeUndefined();
        expect(isAlive(pid)).toBe(false);
      } finally {
        removeSession(projectPath, "chrome");
        if (isAlive(pid)) realKill(pid, "SIGKILL");
      }
    },
    15_000,
  );

  posixOnly(
    "still says unverified when the process table cannot be read",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnHolder([]);
      registerSession({ pid, browser: "chrome", projectPath, command: "dev" });
      windowsHost.table = null;
      try {
        const result = JSON.parse(await onWindows(() => stop.handler({ projectPath, browser: "chrome" })));
        expect(result.value.stopped).toBe(false);
        expect(result.value.survivorsUnverified).toBe(true);
      } finally {
        removeSession(projectPath, "chrome");
        if (isAlive(pid)) realKill(pid, "SIGKILL");
      }
    },
    15_000,
  );
});

describe("A marker that did not land is said", () => {
  it("returns a warning when the marker directory cannot be written", () => {
    const blocker = path.join(tmpProject(), "not-a-dir");
    fs.writeFileSync(blocker, "");
    process.env.EXTENSION_MCP_SESSION_DIR = path.join(blocker, "sessions");
    const projectPath = tmpProject();
    try {
      const warning = registerSession({ pid: 424242, browser: "chrome", projectPath, command: "dev" });
      expect(warning).toContain("could not be written");
      expect(warning).toContain("424242");
    } finally {
      removeSession(projectPath, "chrome");
    }
  });

  it("returns nothing when the marker landed", () => {
    const projectPath = tmpProject();
    try {
      expect(registerSession({ pid: 434343, browser: "chrome", projectPath, command: "dev" })).toBeNull();
    } finally {
      removeSession(projectPath, "chrome");
    }
  });
});

describe("Release promote exits non-zero on an unreadable answer", () => {
  it("exits 1 when the handler output is not an envelope", async () => {
    vi.spyOn(releasePromote, "handler").mockResolvedValue("<html>gateway</html>");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runCli("release", ["promote", "--build", "abc", "--channel", "beta"])).toBe(1);
  });

  it("exits 0 only on ok: true", async () => {
    vi.spyOn(releasePromote, "handler").mockResolvedValue(JSON.stringify({ ok: true }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runCli("release", ["promote", "--build", "abc", "--channel", "beta"])).toBe(0);
  });
});
