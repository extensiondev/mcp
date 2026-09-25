import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as stop from "../tools/stop";

const posixOnly = process.platform === "win32" ? it.skip : it;

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stop-hints-"));
  tmpDirs.push(dir);
  return dir;
}

const holders: number[] = [];
function spawnHolder(args: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  holders.push(child.pid as number);
  return child.pid as number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function writeContract(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown>,
): void {
  const dir = path.join(projectPath, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({ status: "ready", command: "dev", browser, ...contract }),
  );
}

afterEach(() => {
  for (const pid of holders.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_stop reaps the browser the launcher recorded, not only the one whose argv names the project", () => {
  posixOnly(
    "reaps a browser holding a custom profile path that ready.json names",
    async () => {
      const projectPath = tmpProject();
      const profilePath = path.join(os.tmpdir(), `custom-fx-profile-${process.pid}`);
      const pid = spawnHolder(["profile", profilePath, "no-remote"]);
      writeContract(projectPath, "firefox", { profilePath });
      await new Promise((r) => setTimeout(r, 200));

      const result = JSON.parse(
        await stop.handler({ projectPath, browser: "firefox" }),
      );

      expect(result.value.reaped).toContain(pid);
      expect(await waitGone(pid)).toBe(true);
    },
    15_000,
  );

  posixOnly(
    "reaps the browserPid and launcherPid the contract records even when their argv says nothing",
    async () => {
      const projectPath = tmpProject();
      const browserPid = spawnHolder(["quiet-browser"]);
      const launcherPid = spawnHolder(["quiet-launcher"]);
      writeContract(projectPath, "firefox", { browserPid, launcherPid });
      await new Promise((r) => setTimeout(r, 200));

      const result = JSON.parse(
        await stop.handler({ projectPath, browser: "firefox" }),
      );

      expect(result.value.reaped).toEqual(
        expect.arrayContaining([browserPid, launcherPid]),
      );
      expect(await waitGone(browserPid)).toBe(true);
      expect(await waitGone(launcherPid)).toBe(true);
    },
    15_000,
  );

  it("reads the hints out of the contract and ignores what is not a pid", () => {
    const projectPath = tmpProject();
    writeContract(projectPath, "firefox", {
      profilePath: "/tmp/p",
      browserPid: 4242,
      launcherPid: "nope",
    });

    expect(stop.contractProcessHints(projectPath, "firefox")).toEqual({
      profilePath: "/tmp/p",
      pids: [4242],
    });
    expect(stop.contractProcessHints(projectPath, "chrome")).toEqual({ pids: [] });
  });
});
