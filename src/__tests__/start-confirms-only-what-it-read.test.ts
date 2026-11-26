import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as BootVerdictModule from "../lib/boot-verdict";
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

vi.mock("../lib/boot-verdict", async (importOriginal) => {
  const short = (await import("./fixtures/short-boot")).shortBootWindow(await importOriginal<typeof BootVerdictModule>());
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");

  return {
    ...short,
    pollBootVerdict: async (...args: Parameters<typeof short.pollBootVerdict>) => {
      const reading = await short.pollBootVerdict(...args);
      nodeFs.writeFileSync(nodePath.join(args[0], ".boot-polled"), "");

      return reading;
    },
  };
});

vi.mock("node:timers/promises", async (importOriginal) =>
  (await import("./fixtures/short-boot")).shortSleeps(await importOriginal()),
);

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
const { errorContract, readyContract } = await import("./fixtures/engine-answers");

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

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project }));
    const text = JSON.stringify(result);

    expect(result.status).toBe("started");
    expect(result.value.logPath).toBeUndefined();
    expect(text).not.toContain(JSON.stringify(cli!.logPath).slice(1, -1));
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
         setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(body)); }, 50);
         setTimeout(() => {}, 60000);`,
      );

      return cli;
    };

    const result = JSON.parse(await start.handler({ wait: false, projectPath: project }));

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

  it("stops the engine when the contract says the browser exited after the boot window, and says nothing is running", async () => {
    const project = tmpProject();
    const file = readyContractPath(project, "chrome");
    const exited = errorContract("chrome", "browser_exited", { command: "start", distPath: path.join(project, "dist", "chrome") });
    let cli: SpawnedCli | null = null;

    nextChild = () => {
      cli = fakeCli(
        `const fs = require("node:fs"); const path = require("node:path");
         const file = ${JSON.stringify(file)};
         const gate = ${JSON.stringify(path.join(project, ".boot-polled"))};
         const tick = setInterval(() => { if (!fs.existsSync(gate)) return; clearInterval(tick); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(Object.assign(${JSON.stringify(exited)}, { pid: process.pid }))); }, 20);
         setTimeout(() => {}, 60000);`,
      );

      return cli;
    };

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BROWSER_EXITED");
    expect(result.error.message).toContain("The start process was stopped, so nothing is running.");
    expect(result.value.sessionStopped).toBe(true);
    expect(result.hint).toContain("extension_start with replace: true");
    expect(result.hint).not.toContain("extension_dev");
    await vi.waitFor(() => expect(cli!.child.exitCode !== null || cli!.child.signalCode !== null).toBe(true));
  }, 20_000);

  function engineStamps(project: string, code: "extension_load_refused" | "compile_error", then: "stay" | "exit" | "stamp-then-exit"): SpawnedCli {
    const file = readyContractPath(project, "chrome");
    const refused = errorContract("chrome", code, { command: "start", distPath: path.join(project, "dist", "chrome") });
    const cli = fakeCli(
      `const fs = require("node:fs"); const path = require("node:path");
       const file = ${JSON.stringify(file)};
       const gate = ${JSON.stringify(path.join(project, ".boot-polled"))};
       const tick = setInterval(() => {
         if (!fs.existsSync(gate)) return;
         clearInterval(tick);
         ${then === "exit" ? "process.exit(1);" : then === "stamp-then-exit" ? `fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(Object.assign(${JSON.stringify(refused)}, { pid: process.pid }))); setTimeout(() => process.exit(1), 400);` : `fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(Object.assign(${JSON.stringify(refused)}, { pid: process.pid })));`}
       }, 20);
       setTimeout(() => {}, 60000);`,
    );

    if (then === "exit") {
      cli.child.once("exit", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ...refused, pid: cli.child.pid }));
      });
    }

    return cli;
  }

  it("keeps a start session whose failure the engine can still be read on, and gives one next step", async () => {
    const project = tmpProject();
    let cli: SpawnedCli | null = null;

    nextChild = () => (cli = engineStamps(project, "extension_load_refused", "stay"));

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/The start process is still running\.$/);
    expect(result.value.sessionStopped).toBeUndefined();
    expect(result.hint).toContain("extension_start with replace: true");
    expect(result.hint).not.toMatch(/extension_stop|extension_dev/);
    expect(cli!.child.exitCode).toBeNull();
  }, 10_000);

  it("stops the engine on a compile_error, since a start build never rebuilds", async () => {
    const project = tmpProject();
    let cli: SpawnedCli | null = null;

    nextChild = () => (cli = engineStamps(project, "compile_error", "stay"));

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.value.sessionStopped).toBe(true);
    expect(result.error.message).toContain("The start process was stopped, so nothing is running.");
    await vi.waitFor(() => expect(cli!.child.exitCode !== null || cli!.child.signalCode !== null).toBe(true));
  }, 10_000);

  it("says nothing is running when the engine exited after the failed wait", async () => {
    const project = tmpProject();

    nextChild = () => engineStamps(project, "extension_load_refused", "exit");

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("The engine's start process has exited, so nothing is running.");
  }, 10_000);

  it("1268: waits for an engine that stamps its refusal and exits right after, and says nothing is running", async () => {
    const project = tmpProject();

    nextChild = () => engineStamps(project, "extension_load_refused", "stamp-then-exit");

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("The engine's start process has exited, so nothing is running.");
  }, 10_000);

  it("the description says what a production session cannot do, and that the load is read over the debug port", () => {
    expect(start.schema.description).not.toMatch(/opens no debug port/);
    expect(start.schema.description).toMatch(/no hot reload or extension_logs\. Bridge verbs need allowControl:true/);
  });
});
