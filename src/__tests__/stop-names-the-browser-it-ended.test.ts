import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, afterAll } from "vitest";

import * as stop from "../tools/stop";
import { registerSession } from "../lib/process-manager";
import { readyContractPath } from "../lib/session-paths";
import { attachedDevContract, readyContract } from "./fixtures/engine-answers";

const posixOnly = process.platform === "win32" ? it.skip : it;

const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-ended-markers-"));
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

function spawnHolder(label: string): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", label], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  holders.push(child.pid as number);

  return child.pid as number;
}

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-ended-"));
  tmpDirs.push(dir);

  return dir;
}

function writeContract(projectPath: string, body: Record<string, unknown>): void {
  const file = readyContractPath(projectPath, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...body, distPath: path.join(projectPath, "dist", "chrome") }));
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
  for (const pid of holders.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_stop says what it ended, so 'close its browser' needs no shell check after it", () => {
  posixOnly(
    "names the server pid and the browser pid the launcher recorded, each with whether it is gone",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server");
      const browserPid = spawnHolder("browser");
      registerSession({ pid: serverPid, browser: "chrome", projectPath, command: "dev" });
      writeContract(projectPath, attachedDevContract("chrome", { pid: serverPid, browserPid, launcherPid: browserPid }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(result.status).toBe("stopped");
      expect(result.value).toMatchObject({
        pid: serverPid,
        serverGone: true,
        browserPid,
        browserGone: true,
      });

      expect(result.value.detail).toMatch(new RegExp(`browser[^.]*pid ${browserPid}[^.]*gone`));
      expect(isAlive(browserPid)).toBe(false);
    },
    15_000,
  );

  posixOnly(
    "says the contract recorded no browser pid instead of implying the browser was checked",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server-only");
      registerSession({ pid: serverPid, browser: "chrome", projectPath, command: "dev" });
      writeContract(projectPath, readyContract("dev", "chrome", { pid: serverPid }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(result.value.serverGone).toBe(true);
      expect(result.value.browserPid).toBeNull();
      expect(result.value.browserGone).toBeNull();
      expect(result.value.detail).toMatch(/no browser pid/i);
    },
    15_000,
  );

  it("tells the agent in the description that the answer carries the browser's state", () => {
    expect(stop.schema.description).toMatch(/browser pid/i);
  });
});
