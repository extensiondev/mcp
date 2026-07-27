import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as stop from "../tools/stop";
import {
  registerSession,
  removeSession,
  getSession,
  listSessionMarkers,
} from "../lib/process-manager";
import { resolveExtensionInvocation } from "../lib/exec";

const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-markers-"));
process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;

afterAll(() => {
  if (previousSessionDir === undefined) {
    delete process.env.EXTENSION_MCP_SESSION_DIR;
  } else {
    process.env.EXTENSION_MCP_SESSION_DIR = previousSessionDir;
  }
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function spawnVictim(): number {
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

async function waitGone(pid: number, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
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
    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.error.message).toMatch(/projectPath is required/);
  });

  it("reports when no session is known", async () => {
    const result = JSON.parse(
      await stop.handler({ projectPath: tmpProject(), browser: "chrome" }),
    );
    expect(result.value.stopped).toBe(false);
    expect(result.value.pid).toBeNull();
  });

  it("kills a registered session and removes it from the registry", async () => {
    const projectPath = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath, command: "dev" });

    const result = JSON.parse(
      await stop.handler({ projectPath, browser: "chrome" }),
    );

    expect(result.value.pid).toBe(pid);
    expect(result.value.stopped).toBe(true);
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
    expect(result.value.stopped).toBe(true);
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

    expect(result.value.pid).toBe(pid);
    expect(result.value.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
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
    const stoppedPids = result.value.stopped.map((o: { pid: number }) => o.pid);
    expect(stoppedPids).toContain(pidA);
    expect(stoppedPids).toContain(pidB);
    expect(isAlive(pidA)).toBe(false);
    expect(isAlive(pidB)).toBe(false);
  });
});

describe("extension_stop after an MCP restart", () => {
  it("finds a marker-only session that never stamped a ready contract", async () => {
    const projectPath = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath, command: "dev" });
    removeSession(projectPath, "chrome");

    const result = JSON.parse(
      await stop.handler({ projectPath, browser: "chrome" }),
    );

    expect(result.value.pid).toBe(pid);
    expect(result.value.stopped).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(
      listSessionMarkers().some(
        (m) => path.resolve(m.projectPath) === path.resolve(projectPath),
      ),
    ).toBe(false);
  });
});

const posixOnly = process.platform === "win32" ? it.skip : it;

function spawnHolder(command: string, args: string[]): number {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

describe("extension_stop orphan reaping", () => {
  posixOnly(
    "reaps a profile-dir holder even when the project path carries regex metachars",
    async () => {
      const projectPath = path.join(tmpProject(), "weird (c++) [v1]");
      fs.mkdirSync(projectPath, { recursive: true });
      const holderArg = path.join(
        projectPath,
        "dist",
        "extension-profile-chrome",
      );
      const pid = spawnHolder(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
        holderArg,
      ]);
      await new Promise((r) => setTimeout(r, 200));

      const result = JSON.parse(
        await stop.handler({ projectPath, browser: "chrome" }),
      );

      expect(result.value.reaped).toContain(pid);
      expect(await waitGone(pid)).toBe(true);
    },
    15_000,
  );

  posixOnly(
    "does not SIGKILL an unrelated process that merely mentions the profile path",
    async () => {
      const projectPath = tmpProject();
      const watched = path.join(
        projectPath,
        "dist",
        "extension-profile-chrome",
        "session.log",
      );
      fs.mkdirSync(path.dirname(watched), { recursive: true });
      fs.writeFileSync(watched, "log line\n");
      const pid = spawnHolder("tail", ["-f", watched]);
      await new Promise((r) => setTimeout(r, 200));

      try {
        const result = JSON.parse(
          await stop.handler({ projectPath, browser: "chrome" }),
        );

        expect(result.value.reaped).not.toContain(pid);
        expect(isAlive(pid)).toBe(true);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    },
    15_000,
  );

  posixOnly(
    "matches a dev server spawned with the caller's relative path spelling",
    async () => {
      const absolute = tmpProject();
      const relative = path.relative(process.cwd(), absolute);
      const pid = spawnHolder(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
        "extension",
        "dev",
        relative,
      ]);
      await new Promise((r) => setTimeout(r, 200));

      const result = JSON.parse(
        await stop.handler({ projectPath: relative, browser: "chrome" }),
      );

      expect(result.value.reaped).toContain(pid);
      expect(await waitGone(pid)).toBe(true);
    },
    15_000,
  );
});

describe("resolveExtensionInvocation", () => {
  it("pins the npx fallback to the vendored extension-develop version", () => {
    const { command, prefixArgs } = resolveExtensionInvocation();
    expect(command).toBe("npx");
    expect(prefixArgs).toHaveLength(1);
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
