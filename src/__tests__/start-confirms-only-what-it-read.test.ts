import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";

const spawned: ChildProcess[] = [];

function fakeCli(script: string): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);

  return {
    child,
    logPath,
    readOutput: () => {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

let nextChild: () => SpawnedCli = () => fakeCli("setTimeout(()=>{}, 60000)");

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => nextChild(),
  };
});

const start = await import("../tools/start");
const wait = await import("../tools/wait");
const { removeSession } = await import("../lib/process-manager");
const { readyContractPath } = await import("../lib/session-paths");
const { readyContract } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-confirms-"));
  tmpDirs.push(dir);

  return dir;
}

function startContract(project: string, overrides: Record<string, unknown>): void {
  const file = readyContractPath(project, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      readyContract("start", "chrome", {
        pid: process.pid,
        distPath: path.join(project, "dist", "chrome"),
        compiledAt: new Date().toISOString(),
        ...overrides,
      }),
    ),
  );
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }

  nextChild = () => fakeCli("setTimeout(()=>{}, 60000)");
});

describe("extension_start confirms only what it read and never points at a temp file", () => {
  it("drops the session log path and names the tools instead", async () => {
    const project = tmpProject();
    let cli: SpawnedCli | null = null;

    nextChild = () => {
      cli = fakeCli('console.log("building"); setTimeout(()=>{}, 60000);');

      return cli;
    };

    const result = JSON.parse(await start.handler({ projectPath: project }));
    const text = JSON.stringify(result);

    expect(result.status).toBe("started");
    expect(result.value.logPath).toBeUndefined();
    expect(text).not.toContain(cli!.logPath);
    expect(text).not.toMatch(/session\.log/);
    expect(result.value.extensionLoaded).toBeNull();
    expect(result.hint).toMatch(/cannot confirm/);
    expect(result.hint).toMatch(/extension_logs/);
    expect(result.hint).toMatch(/extension_dev/);
  }, 15_000);

  it("reads the browser pid the launcher stamped and says the load itself is unread", async () => {
    const project = tmpProject();
    const file = readyContractPath(project, "chrome");
    let cli: SpawnedCli | null = null;
    const stamped = readyContract("start", "chrome", { distPath: path.join(project, "dist", "chrome") });

    nextChild = () => {
      cli = fakeCli(
        `const fs = require("node:fs"); const path = require("node:path");
         const file = ${JSON.stringify(file)};
         const body = Object.assign(${JSON.stringify(stamped)}, { pid: process.pid, browserPid: process.pid, launcherPid: process.pid });
         setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(body)); }, 500);
         setTimeout(() => {}, 60000);`,
      );

      return cli;
    };

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.status).toBe("started");
    expect(result.value.browserPid).toBe(cli!.child.pid);
    expect(result.value.browserAlive).toBe(true);
    expect(result.value.extensionLoaded).toBeNull();
    expect(result.value.loadEvidence).toMatch(/no debug port/);
  }, 15_000);

  it("extension_wait on a start session reports the launched browser and what it cannot read, without a temp path", async () => {
    const project = tmpProject();
    startContract(project, { browserPid: process.pid, launcherPid: process.pid });

    const result = JSON.parse(await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1500 }));
    const text = JSON.stringify(result);

    expect(result.status).toBe("build-ready");
    expect(result.value).toMatchObject({ browserPid: process.pid, browserAlive: true, extensionLoaded: null });
    expect(result.hint).toMatch(/not that the browser loaded the extension/);
    expect(result.hint).toMatch(/extension_logs/);
    expect(text).not.toMatch(/session\.log/);
  }, 10_000);

  it("extension_wait says when the recorded browser is gone", async () => {
    const project = tmpProject();
    startContract(project, { browserPid: 2 ** 30 });

    const result = JSON.parse(await wait.handler({ projectPath: project, browser: "chrome", timeoutMs: 1500 }));

    expect(result.status).toBe("build-ready");
    expect(result.value.browserAlive).toBe(false);
    expect(result.value.loadEvidence).toMatch(/gone/);
  }, 10_000);

  it("the description says what a production session can and cannot confirm", () => {
    expect(start.schema.description).toMatch(/loaded the extension/);
  });
});
