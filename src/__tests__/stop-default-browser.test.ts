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

import { afterAll, afterEach, describe, expect, it } from "vitest";

import * as stop from "../tools/stop";

const posixOnly = process.platform === "win32" ? it.skip : it;

const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-default-browser-markers-"));
process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;

afterAll(() => {
  if (previousSessionDir === undefined) {
    delete process.env.EXTENSION_MCP_SESSION_DIR;
  } else {
    process.env.EXTENSION_MCP_SESSION_DIR = previousSessionDir;
  }

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

const holders: number[] = [];
const tmpDirs: string[] = [];

function spawnDevServer(argv: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...argv], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  holders.push(child.pid as number);

  return child.pid as number;
}

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-default-browser-"));
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

async function waitGone(pid: number, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return !isAlive(pid);
}

afterEach(() => {
  for (const pid of holders.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_stop reads a dev server with no browser flag as the engine's chrome default", () => {
  posixOnly(
    "keeps a person's flagless dev server alive when the project's firefox session is stopped",
    async () => {
      const projectPath = tmpProject();
      const chrome = spawnDevServer(["extension", "dev", projectPath, "--allow-control"]);
      const firefox = spawnDevServer(["extension", "dev", projectPath, "--browser", "firefox", "--allow-control"]);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(await stop.handler({ projectPath, browser: "firefox" }));

      expect(result.value.reaped).toContain(firefox);
      expect(await waitGone(firefox)).toBe(true);
      expect(result.value.reaped).not.toContain(chrome);
      expect(isAlive(chrome)).toBe(true);
    },
    15_000,
  );

  posixOnly(
    "ends a flagless dev server when chrome, the engine's default, is stopped",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnDevServer(["extension", "dev", projectPath, "--allow-control"]);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(result.value.reaped).toContain(pid);
      expect(await waitGone(pid)).toBe(true);
    },
    15_000,
  );

  posixOnly(
    "keeps a flagless dev server alive when a chromium session, not the chrome default, is stopped",
    async () => {
      const projectPath = tmpProject();
      const chrome = spawnDevServer(["extension", "dev", projectPath, "--allow-control"]);
      const chromium = spawnDevServer(["extension", "dev", projectPath, "--browser", "chromium"]);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chromium" }));

      expect(result.value.reaped).toContain(chromium);
      expect(await waitGone(chromium)).toBe(true);
      expect(result.value.reaped).not.toContain(chrome);
      expect(isAlive(chrome)).toBe(true);
    },
    15_000,
  );
});
