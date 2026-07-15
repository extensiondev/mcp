import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as stop from "../tools/stop";
import { registerSession, getSession } from "../lib/process-manager";
import { resolveExtensionInvocation } from "../lib/exec";

function spawnVictim(): number {
  // A detached long-lived process standing in for `extension dev`.
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
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

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_stop", () => {
  it("requires projectPath unless all=true", async () => {
    const result = JSON.parse(await stop.handler({}));
    expect(result.error).toMatch(/projectPath is required/);
  });

  it("reports when no session is known", async () => {
    const result = JSON.parse(
      await stop.handler({ projectPath: tmpProject(), browser: "chrome" }),
    );
    expect(result.stopped).toBe(false);
    expect(result.pid).toBeNull();
  });

  it("kills a registered session and removes it from the registry", async () => {
    const projectPath = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath, command: "dev" });

    const result = JSON.parse(
      await stop.handler({ projectPath, browser: "chrome" }),
    );

    expect(result.pid).toBe(pid);
    expect(result.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(getSession(projectPath, "chrome")).toBeUndefined();
  });

  it("resolves sessions registered under a relative path via normalized keys", async () => {
    const projectPath = tmpProject();
    const relative = path.relative(process.cwd(), projectPath);
    const pid = spawnVictim();
    registerSession({
      pid,
      browser: "chrome",
      projectPath: relative,
      command: "dev",
    });

    const result = JSON.parse(
      await stop.handler({ projectPath, browser: "chrome" }),
    );
    expect(result.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });

  it("falls back to the ready.json contract when the registry is empty", async () => {
    const projectPath = tmpProject();
    const pid = spawnVictim();
    const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
    fs.mkdirSync(readyDir, { recursive: true });
    const readyPath = path.join(readyDir, "ready.json");
    fs.writeFileSync(
      readyPath,
      JSON.stringify({ status: "ready", command: "dev", browser: "chrome", pid }),
    );

    const result = JSON.parse(
      await stop.handler({ projectPath, browser: "chrome" }),
    );

    expect(result.pid).toBe(pid);
    expect(result.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
    // The stale contract must not survive, or extension_wait would report a
    // dead session as ready.
    expect(fs.existsSync(readyPath)).toBe(false);
  });

  it("stops everything with all=true", async () => {
    const projectA = tmpProject();
    const projectB = tmpProject();
    const pidA = spawnVictim();
    const pidB = spawnVictim();
    registerSession({
      pid: pidA,
      browser: "chrome",
      projectPath: projectA,
      command: "dev",
    });
    registerSession({
      pid: pidB,
      browser: "firefox",
      projectPath: projectB,
      command: "start",
    });

    const result = JSON.parse(await stop.handler({ all: true }));
    const stoppedPids = result.stopped.map((o: { pid: number }) => o.pid);
    expect(stoppedPids).toContain(pidA);
    expect(stoppedPids).toContain(pidB);
    expect(isAlive(pidA)).toBe(false);
    expect(isAlive(pidB)).toBe(false);
  });
});

describe("resolveExtensionInvocation", () => {
  it("pins the npx fallback to the vendored extension-develop version", () => {
    const { command, prefixArgs } = resolveExtensionInvocation();
    expect(command).toBe("npx");
    expect(prefixArgs).toHaveLength(1);
    // The vendored engine may be a stable or a prerelease (CI pins canary).
    expect(prefixArgs[0]).toMatch(/^extension@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("prefers the project-local extension bin when present", () => {
    const projectPath = tmpProject();
    const binDir = path.join(projectPath, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binName = process.platform === "win32" ? "extension.cmd" : "extension";
    const bin = path.join(binDir, binName);
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const { command, prefixArgs } = resolveExtensionInvocation(projectPath);
    expect(command).toBe(bin);
    expect(prefixArgs).toEqual([]);
  });
});
