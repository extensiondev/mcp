import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as stop from "../tools/stop";
import { registerSession, removeSession } from "../lib/process-manager";

const windowsOnly = process.platform === "win32" ? it : it.skip;

const previousSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-win-markers-"));
process.env.EXTENSION_MCP_SESSION_DIR = sessionDir;

afterAll(() => {
  if (previousSessionDir === undefined) delete process.env.EXTENSION_MCP_SESSION_DIR;
  else process.env.EXTENSION_MCP_SESSION_DIR = previousSessionDir;
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/* @invariant This is the one cell that runs the Windows stop for real. The
   other stop cells signal POSIX process groups and are skipped here, and the
   win32 cell in lifecycle-wave6 only fakes the platform, so before this cell
   no run had shown taskkill /T /F ending a real tree. The
   parent stands in for the dev server and its child for the browser it
   launched; the child is what a shim-only kill used to leave running. Since
   the survivor search reads the Windows process table, so a
   stop that ended the tree says stopped instead of unverified. */
describe("extension_stop on a real Windows host", () => {
  windowsOnly(
    "ends the session's whole process tree and confirms nothing of it is left",
    async () => {
      const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-win-"));
      const childPidFile = path.join(projectPath, "child.pid");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
        `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parent = spawn(process.execPath, ["-e", parentScript], {
        stdio: "ignore",
        windowsHide: true,
      });
      const parentPid = parent.pid!;
      let childPid = 0;
      try {
        expect(await waitFor(() => fs.existsSync(childPidFile), 10_000)).toBe(true);
        childPid = Number(fs.readFileSync(childPidFile, "utf8"));
        expect(isAlive(parentPid)).toBe(true);
        expect(isAlive(childPid)).toBe(true);

        registerSession({ pid: parentPid, browser: "chrome", projectPath, command: "dev" });
        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(await waitFor(() => !isAlive(parentPid), 5_000)).toBe(true);
        expect(await waitFor(() => !isAlive(childPid), 5_000)).toBe(true);
        expect(result.value.stopped).toBe(true);
        expect(result.value.survivorsUnverified).toBeUndefined();
      } finally {
        removeSession(projectPath, "chrome");
        for (const pid of [childPid, parentPid]) {
          if (pid && isAlive(pid)) {
            try {
              process.kill(pid);
            } catch {
            }
          }
        }
        fs.rmSync(projectPath, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
