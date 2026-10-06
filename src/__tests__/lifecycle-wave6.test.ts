import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const taskkillCalls: string[][] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = ((file: string, args?: readonly string[], options?: unknown) => {
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
