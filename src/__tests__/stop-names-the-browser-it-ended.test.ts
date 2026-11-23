import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, afterAll } from "vitest";

import { emptyReason } from "../tools/logs";
import * as stop from "../tools/stop";
import { contractPidStartedAt, contractPidState } from "../lib/contract-pids";
import { processStartedAt, procfs } from "../lib/process-identity";
import { findSessionInfo, listSessionMarkers, registerSession } from "../lib/process-manager";
import { readyContractPath } from "../lib/session-paths";
import { attachedDevContract, readyContract } from "./fixtures/engine-answers";

type Body = Record<string, unknown>;

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

async function waitGone(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (isAlive(pid) && Date.now() < deadline) {
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
      expect(await waitGone(browserPid)).toBe(true);
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
    expect(stop.schema.description).toMatch(/browser pid it ended/i);
  });
});

describe("extension_stop judges the contract's browser and launcher pids by their start times", () => {
  posixOnly(
    "reads a browser pid whose start time no longer matches the record as gone and leaves that process alone",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server");
      const browserPid = spawnHolder("browser");
      registerSession({
        pid: serverPid,
        browser: "chrome",
        projectPath,
        command: "dev",
        browserPid,
        browserStartedAt: "2001-01-01T00:00:00.000Z",
        launcherPid: browserPid,
        launcherStartedAt: "2001-01-01T00:00:00.000Z",
      });

      writeContract(projectPath, attachedDevContract("chrome", { pid: serverPid, browserPid, launcherPid: browserPid }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(result.value).toMatchObject({ pid: serverPid, serverGone: true, browserPid, browserGone: true, stopped: true });
      expect(result.value.reaped).not.toContain(browserPid);
      expect(result.value.detail).toMatch(new RegExp(`browser[^.]*pid ${browserPid}[^.]*gone`));
      expect(isAlive(browserPid)).toBe(true);
    },
    15_000,
  );

  posixOnly(
    "stamps the browser and launcher pids with their start times the first time it reads the contract and keeps them in the record",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server");
      const browserPid = spawnHolder("browser");
      const launcherPid = spawnHolder("launcher");
      registerSession({ pid: serverPid, browser: "chrome", projectPath, command: "dev" });
      writeContract(projectPath, attachedDevContract("chrome", { pid: serverPid, browserPid, launcherPid }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(stop.contractProcessHints(projectPath, "chrome").pids).toEqual([browserPid, launcherPid]);

      const recorded = findSessionInfo(projectPath, "chrome");
      expect(recorded).toMatchObject({ browserPid, launcherPid });
      expect(typeof recorded?.browserStartedAt).toBe("string");
      expect(typeof recorded?.launcherStartedAt).toBe("string");
      expect(Math.abs(Date.parse(recorded!.browserStartedAt!) - Date.now())).toBeLessThan(60_000);
      const marker = listSessionMarkers().find(
        (m) => path.resolve(m.projectPath) === path.resolve(projectPath) && m.browser === "chrome",
      );
      expect(marker).toMatchObject({
        browserPid,
        browserStartedAt: recorded?.browserStartedAt,
        launcherPid,
        launcherStartedAt: recorded?.launcherStartedAt,
      });

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(result.value).toMatchObject({ browserPid, browserGone: true, stopped: true });
      expect(result.value.reaped).toEqual(expect.arrayContaining([browserPid, launcherPid]));
      expect(await waitGone(browserPid)).toBe(true);
      expect(await waitGone(launcherPid)).toBe(true);
    },
    15_000,
  );
});

describe("a ready contract that dates its own pids is believed before any stamp this server took", () => {
  const LONG_AGO = "2001-01-01T00:00:00.000Z";

  posixOnly(
    "trusts the contract's browser and launcher start times on a run this server never registered and records nothing",
    async () => {
      const projectPath = tmpProject();
      const browserPid = spawnHolder("browser");
      const launcherPid = spawnHolder("launcher");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const browserStartedAt = processStartedAt(browserPid);
      expect(typeof browserStartedAt).toBe("string");
      const contract = attachedDevContract("chrome", {
        pid: process.pid,
        browserPid,
        browserStartedAt,
        launcherPid,
        launcherStartedAt: LONG_AGO,
      });
      writeContract(projectPath, contract);

      expect(contractPidStartedAt(projectPath, "chrome", contract, "browser")).toBe(browserStartedAt);
      expect(contractPidState(projectPath, "chrome", contract, "browser")).toBe("alive");
      expect(contractPidStartedAt(projectPath, "chrome", contract, "launcher")).toBe(LONG_AGO);
      expect(contractPidState(projectPath, "chrome", contract, "launcher")).toBe("dead");
      expect(stop.contractProcessHints(projectPath, "chrome").startedAt).toEqual({
        [browserPid]: browserStartedAt,
        [launcherPid]: LONG_AGO,
      });

      expect(findSessionInfo(projectPath, "chrome")).toBeUndefined();
    },
    15_000,
  );

  posixOnly(
    "takes the contract's browser start time over the one in this server's record",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server");
      const browserPid = spawnHolder("browser");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const browserStartedAt = processStartedAt(browserPid);
      registerSession({
        pid: serverPid,
        browser: "chrome",
        projectPath,
        command: "dev",
        browserPid,
        browserStartedAt: LONG_AGO,
      });

      const contract = attachedDevContract("chrome", { pid: serverPid, browserPid, browserStartedAt, launcherPid: browserPid });

      expect(contractPidStartedAt(projectPath, "chrome", contract, "browser")).toBe(browserStartedAt);
      expect(contractPidState(projectPath, "chrome", contract, "browser")).toBe("alive");
      expect(findSessionInfo(projectPath, "chrome")?.browserStartedAt).toBe(LONG_AGO);
    },
    15_000,
  );

  posixOnly(
    "1022 d: a session's engine and browser stay alive across a step of the wall clock, by the clock ticks its record took",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server");
      const browserPid = spawnHolder("browser");
      const proc = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proc-ticks-"));
      const previousRoot = procfs.root;

      const stat = (pid: number, ticks: number): void => {
        fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
        fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 900 0 0 0 12 3 0 0 20 0 11 0 ${ticks} 1 2 3`);
      };

      tmpDirs.push(proc);
      await new Promise((resolve) => setTimeout(resolve, 200));
      stat(serverPid, 500);
      stat(browserPid, 700);
      procfs.root = proc;

      try {
        registerSession({ pid: serverPid, browser: "chrome", projectPath, command: "dev" });

        const browserStartedAt = processStartedAt(browserPid);
        const contract = attachedDevContract("chrome", { pid: serverPid, pidStartedAt: processStartedAt(serverPid), browserPid, browserStartedAt });

        expect(contractPidState(projectPath, "chrome", contract, "browser")).toBe("alive");
        expect(findSessionInfo(projectPath, "chrome")).toMatchObject({ processStartTicks: 500, browserPid, browserStartTicks: 700 });
        expect(listSessionMarkers().find((marker) => marker.pid === serverPid)).toMatchObject({ processStartTicks: 500, browserStartTicks: 700 });

        const hourEarlier = (stamp: string | null): string => new Date(Date.parse(stamp ?? new Date().toISOString()) - 3_600_000).toISOString();
        const stepped = { ...contract, pidStartedAt: hourEarlier(processStartedAt(serverPid)), browserStartedAt: hourEarlier(browserStartedAt) };

        expect(contractPidState(projectPath, "chrome", stepped, "engine")).toBe("alive");
        expect(contractPidState(projectPath, "chrome", stepped, "browser")).toBe("alive");
        expect(stop.contractProcessHints(projectPath, "chrome").startTicks).toBeUndefined();

        writeContract(projectPath, stepped);

        expect(stop.contractProcessHints(projectPath, "chrome").startTicks).toEqual({ [browserPid]: 700 });

        stat(browserPid, 701);

        expect(contractPidState(projectPath, "chrome", stepped, "browser")).toBe("dead");
      } finally {
        procfs.root = previousRoot;
      }
    },
    15_000,
  );

  posixOnly(
    "falls back to its own stamps when the contract carries no start time or one that is not a date",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("server");
      const browserPid = spawnHolder("browser");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const bare = attachedDevContract("chrome", { pid: serverPid, browserPid, launcherPid: browserPid });

      expect(contractPidStartedAt(projectPath, "chrome", bare, "engine")).toBeNull();
      expect(contractPidStartedAt(projectPath, "chrome", bare, "browser")).toBeNull();
      expect(contractPidState(projectPath, "chrome", bare, "engine")).toBe("alive");

      registerSession({ pid: serverPid, browser: "chrome", projectPath, command: "dev", processStartedAt: LONG_AGO });
      const unreadable: Body = { ...bare, pidStartedAt: "not a date", browserStartedAt: 12 };

      expect(contractPidStartedAt(projectPath, "chrome", unreadable, "engine")).toBe(LONG_AGO);
      expect(contractPidStartedAt(projectPath, "chrome", unreadable, "browser")).toBe(processStartedAt(browserPid));
      expect(findSessionInfo(projectPath, "chrome")).toMatchObject({ browserPid, browserStartedAt: processStartedAt(browserPid) });
    },
    15_000,
  );

  posixOnly(
    "reads a reused dev server pid as dead on a run this server never registered, and extension_logs says so",
    async () => {
      const projectPath = tmpProject();
      const serverPid = spawnHolder("someone-else");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const contract = readyContract("dev", "chrome", { pid: serverPid, pidStartedAt: LONG_AGO });
      writeContract(projectPath, contract);

      expect(findSessionInfo(projectPath, "chrome")).toBeUndefined();
      expect(contractPidStartedAt(projectPath, "chrome", contract, "engine")).toBe(LONG_AGO);
      expect(contractPidState(projectPath, "chrome", contract, "engine")).toBe("dead");
      expect(emptyReason(projectPath, "chrome")).toMatch(new RegExp(`dev-server pid ${serverPid} is dead`));

      const honest: Body = { ...contract, pidStartedAt: processStartedAt(serverPid) };
      expect(contractPidState(projectPath, "chrome", honest, "engine")).toBe("alive");
    },
    15_000,
  );

  it(
    "reads a live dev server as alive from the start time the engine reads off its own clock, as 4.1.40 stamps it on Windows",
    async () => {
      const projectPath = tmpProject();
      const stampFile = path.join(projectPath, "own-clock.txt");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(stampFile)}, new Date(Date.now() - process.uptime() * 1000).toISOString()); setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      const serverPid = child.pid as number;
      holders.push(serverPid);

      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(stampFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

      const ownClock = fs.readFileSync(stampFile, "utf8");
      const contract = readyContract("dev", "chrome", { pid: serverPid, pidStartedAt: ownClock });

      expect(contractPidStartedAt(projectPath, "chrome", contract, "engine")).toBe(ownClock);
      expect(contractPidState(projectPath, "chrome", contract, "engine")).toBe("alive");
    },
    30_000,
  );
});
