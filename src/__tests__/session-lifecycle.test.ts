import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";

import { readyContract } from "./fixtures/engine-answers";
import { envelope } from "../lib/envelope";
import { armSessionIdle, idleClock, idleRecordPath, idledOutPath, readIdledOut, resolveIdleMinutes } from "../lib/session-idle";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";

import type * as WaitModule from "../tools/wait";
import type * as LogsModule from "../tools/logs";
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
let spawnCount = 0;
const installRuns: string[] = [];

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => {
      spawnCount += 1;

      return nextChild();
    },
    runPackageInstall: async (_command: string, _args: string[], options: { cwd: string }) => {
      installRuns.push(options.cwd);
      fs.mkdirSync(path.join(options.cwd, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, "node_modules", ".bin", process.platform === "win32" ? "extension.cmd" : "extension"), "");

      return { code: 0, timedOut: false, output: "" };
    },
  };
});

const waitCalls: object[] = [];
const logsCalls: object[] = [];
let waitAnswer = (): string =>
  JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: true } });
const readyAnswer = waitAnswer;
const real: { wait?: typeof WaitModule.handler; logs?: typeof LogsModule.handler; budgetMs: number | null } = { budgetMs: null };

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();
  real.wait = actual.handler;

  return {
    ...actual,
    handler: async (args: Parameters<typeof WaitModule.handler>[0]) => {
      waitCalls.push(args);

      return real.budgetMs === null ? waitAnswer() : actual.handler({ ...args, timeoutMs: real.budgetMs });
    },
  };
});

vi.mock("../tools/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof LogsModule>();
  real.logs = actual.handler;

  return {
    ...actual,
    handler: async (args: Parameters<typeof LogsModule.handler>[0]) => {
      logsCalls.push(args);

      return real.budgetMs === null
        ? JSON.stringify({ ok: true, status: "ok", value: { count: 2, lines: ["[background] hello", "[newtab] hello"] } })
        : actual.handler(args);
    },
  };
});

const dev = await import("../tools/dev");
const stop = await import("../tools/stop");
const evalTool = await import("../tools/eval");
const start = await import("../tools/start");
const { installRecordPath, runningInstall } = await import("../lib/project-install");
const { processStartedAt } = await import("../lib/process-identity");
const { TOOL_POLICY } = await import("../lib/tool-policy");
const { registerSession, removeSession, removeSessionMarker, listSessionMarkers } = await import(
  "../lib/process-manager"
);

function spawnVictim(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  spawned.push(child);

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

async function waitGone(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return !isAlive(pid);
}

function writeReadyContract(
  project: string,
  browser: string,
  pid: number,
): void {
  const dir = path.join(project, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify(readyContract("dev", browser, { pid, distPath: path.join(project, "dist", browser) })),
  );
}

function stampBrowserExited(project: string, browser: string): void {
  const dir = path.join(project, "dist", "extension-js", browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({
      status: "error",
      code: "browser_exited",
      browserExitCode: 1,
      browserExitedAt: new Date().toISOString(),
    }),
  );
}

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-life-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  waitAnswer = readyAnswer;
  real.budgetMs = null;

  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    for (const browser of ["chrome", "firefox"]) {
      try {
        removeSession(dir, browser);
        removeSessionMarker(dir, browser);
      } catch {
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev fork guard", () => {
  it("does not take a stranger holding a recorded pid for a live session", async () => {
    if (process.platform === "win32") return;

    const project = tmpProject();
    const stranger = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    stranger.unref();
    spawned.push(stranger);
    await new Promise((resolve) => setTimeout(resolve, 200));
    registerSession({ pid: stranger.pid!, browser: "chrome", projectPath: project, command: "dev", processStartedAt: "2001-01-01T00:00:00.000Z" });

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.status).not.toBe("session-exists");
  });

  it("refuses a second dev call while a live session holds the project", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("session-exists");
    expect(result.error.code).toBe("E_SESSION_EXISTS");
    expect(result.value.sessions).toEqual([{ pid, browser: "chrome" }]);
    expect(result.hint).toContain("replace: true");
    expect(result.hint).toContain("extension_stop");
    expect(isAlive(pid)).toBe(true);
  });

  it("answers with the readiness and the first logs by default, from the wait and logs tools", async () => {
    const project = tmpProject();
    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.value.ready).toMatchObject({ status: "ready", browserAttached: true });
    expect(result.value.firstLogs).toMatchObject({ count: 2 });
    expect(waitCalls).toEqual([{ projectPath: project, browser: "chrome", timeoutMs: 45_000 }]);
    expect(logsCalls).toEqual([{ projectPath: project, browser: "chrome", limit: 20 }]);
  });

  it("sends the agent on from a ready answer instead of to extension_wait", async () => {
    const project = tmpProject();
    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.value.ready.status).toBe("ready");
    expect(result.hint).toMatch(/^The session is ready \(ready\.status: ready\)[^.]*no extension_wait is needed/);
    expect(result.hint).not.toMatch(/Use extension_wait/);
  });

  it("keeps extension_wait as the next call when the readiness it waited for was not ready", async () => {
    waitAnswer = () =>
      JSON.stringify({ ok: false, status: "timeout", value: { compiled: false, browserAttached: false } });

    const project = tmpProject();
    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.value.ready.status).toBe("timeout");
    expect(result.hint).toMatch(/^ready\.status is timeout, not ready: call extension_wait/);
  });

  it("returns as soon as the server is spawned with wait: false", async () => {
    const project = tmpProject();
    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.status).toBe("started");
    expect(result.value.ready).toBeUndefined();
    expect(result.value.firstLogs).toBeUndefined();
    expect(result.hint).toMatch(/^Use extension_wait to check when the extension is fully loaded/);
  });

  it("also sees a live session recorded only in the ready.json contract", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    writeReadyContract(project, "chrome", pid);

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("session-exists");
    expect(result.value.sessions[0].pid).toBe(pid);
  });

  it("replace:true stops the old session and reports it as replacedSession", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(
      await dev.handler({ wait: false, projectPath: project, replace: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.value.replacedSession).toEqual({ pid, browser: "chrome" });
    expect(await waitGone(pid)).toBe(true);
  }, 20_000);
});

describe("extension_dev keeps one session per browser, not per project", () => {
  it("starts a session for another browser beside the live one", async () => {
    const project = tmpProject();
    const chromePid = spawnVictim();
    registerSession({ pid: chromePid, browser: "chrome", projectPath: project, command: "dev" });

    const result = JSON.parse(
      await dev.handler({ wait: false, projectPath: project, browser: "firefox" }),
    );

    expect(result.status).toBe("started");
    expect(result.ok).toBe(true);
    expect(result.value.replacedSession).toBeUndefined();
    expect(isAlive(chromePid)).toBe(true);
  });

  it("refuses a same-browser session and lists only the session that owns its output", async () => {
    const project = tmpProject();
    const chromePid = spawnVictim();
    const firefoxPid = spawnVictim();
    registerSession({ pid: chromePid, browser: "chrome", projectPath: project, command: "dev" });
    registerSession({ pid: firefoxPid, browser: "firefox", projectPath: project, command: "dev" });

    const result = JSON.parse(
      await dev.handler({ wait: false, projectPath: project, browser: "chrome" }),
    );

    expect(result.status).toBe("session-exists");
    expect(result.error.code).toBe("E_SESSION_EXISTS");
    expect(result.value.sessions).toEqual([{ pid: chromePid, browser: "chrome" }]);
    expect(result.error.message).toContain("dist/chrome");
    expect(result.error.message).not.toContain("firefox");
  });

  it("replace:true stops only the session of the browser it replaces", async () => {
    const project = tmpProject();
    const chromePid = spawnVictim();
    const firefoxPid = spawnVictim();
    registerSession({ pid: chromePid, browser: "chrome", projectPath: project, command: "dev" });
    registerSession({ pid: firefoxPid, browser: "firefox", projectPath: project, command: "dev" });

    const result = JSON.parse(
      await dev.handler({ wait: false, projectPath: project, browser: "chrome", replace: true }),
    );

    expect(result.status).toBe("started");
    expect(result.value.replacedSession).toEqual({ pid: chromePid, browser: "chrome" });
    expect(await waitGone(chromePid)).toBe(true);
    expect(isAlive(firefoxPid)).toBe(true);
  }, 20_000);
});

describe("extension_dev replace:true believes the stop, not its own request", () => {
  it("refuses to start when the old session survived its stop", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    const stopSpy = vi.spyOn(stop, "stopOne").mockResolvedValue({
      projectPath: project,
      browser: "chrome",
      pid,
      serverGone: false,
      browserPid: 4242,
      browserGone: false,
      stopped: false,
      reaped: [],
      detail: "Sent SIGTERM and SIGKILL but the process still reports alive; it may be exiting. Warning: 1 browser process(es) still alive after reap (pids 4242).",
    });

    try {
      const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, replace: true }));

      expect(result.ok).toBe(false);
      expect(result.status).toBe("replace-failed");
      expect(result.error.message).toContain("still reports alive");
      expect(result.value.replacedSession).toBeUndefined();
    } finally {
      stopSpy.mockRestore();

      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  });
});

describe("extension_dev exit cleanup", () => {
  it("removes the on-disk session marker when the dev server exits", async () => {
    const project = tmpProject();
    nextChild = () => fakeCli('console.log("boot"); process.exit(1);');

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.status).toBe("exited");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const markers = listSessionMarkers().map((m) =>
      path.resolve(m.projectPath),
    );
    expect(markers).not.toContain(path.resolve(project));
  }, 15_000);
});

describe("extension_dev browser leg health", () => {
  it("reports ok:false when the browser died behind a surviving dev server", async () => {
    const project = tmpProject();

    nextChild = () => {
      const cli = fakeCli("setTimeout(()=>{}, 60000)");
      setTimeout(() => stampBrowserExited(project, "chrome"), 1000);

      return cli;
    };

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("browser-exited");
    expect(result.error.code).toBe("E_BROWSER_EXITED");
    expect(result.value.browserExitCode).toBe(1);
    expect(result.error.message).toContain("browser");
    expect(result.hint).toContain(
      path.join(project, "dist", "extension-js", "profiles", "chrome-profile"),
    );
  }, 15_000);

  it("splits a profile lock out of browser-exited, even on engines without the stamp", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli(
        'console.log("Failed to create a ProcessSingleton for your profile directory"); setTimeout(()=>{}, 60000);',
      );

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("profile-locked");
    expect(result.error.code).toBe("E_PROFILE_LOCKED");
    expect(result.error.message).toContain("profile is locked");
    expect(result.hint).toContain(
      path.join(project, "dist", "extension-js", "profiles", "chrome-profile"),
    );

    expect(result.hint).not.toContain("extension-profile-chrome");
    expect(result.warnings.join(" ")).toContain("machine contract");
  }, 15_000);
});

describe("extension_stop all:true discovery", () => {
  it("finds a live session through on-disk markers after registry amnesia", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    writeReadyContract(project, "chrome", pid);
    removeSession(project, "chrome");

    const result = JSON.parse(await stop.handler({ all: true }));

    expect(result.status).toBe("stopped-all");
    const mine = result.value.stopped.find(
      (o: { projectPath: string }) => path.resolve(o.projectPath) === project,
    );
    expect(mine).toBeDefined();
    expect(mine.pid).toBe(pid);
    expect(mine.stopped).toBe(true);
    expect(await waitGone(pid)).toBe(true);
    const remaining = listSessionMarkers().map((m) =>
      path.resolve(m.projectPath),
    );
    expect(remaining).not.toContain(project);
  }, 20_000);

  it("says so honestly when neither registry nor markers know a session", async () => {
    for (const m of listSessionMarkers()) {
      await stop.handler({ projectPath: m.projectPath, browser: m.browser, all: false });
    }

    const result = JSON.parse(await stop.handler({ all: true }));
    expect(result.value.stopped).toEqual([]);
    expect(result.status).toBe("nothing-to-stop");
    expect(result.hint).toContain("no session markers");
  }, 30_000);
});

describe("ledger 515: a session the agent owns ends itself after an idle time, and the next call says so", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    nextChild = () => fakeCli("setTimeout(()=>{}, 60000)");
  });

  it("a headless extension_dev takes a 30 minute idle limit by default, names it, and arms the idle record", async () => {
    const project = tmpProject();
    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, headless: true }));

    expect(result.status).toBe("started");
    expect(result.value.idleMinutes).toBe(30);
    expect(result.hint).toContain("ends itself after 30 minutes");
    expect(result.hint).toContain("idleMinutes");

    const record = JSON.parse(fs.readFileSync(idleRecordPath(project, "chrome"), "utf8"));
    expect(record.pid).toBe(result.value.pid);
    expect(record.idleMs).toBe(30 * 60_000);
    expect(record.session).toEqual({ projectPath: path.resolve(project), browser: "chrome" });
  });

  it("a visible extension_dev window keeps no idle limit unless idleMinutes is given, and 0 means never", async () => {
    const project = tmpProject();
    const shown = JSON.parse(await dev.handler({ wait: false, projectPath: project, headless: false }));

    expect(shown.value.idleMinutes).toBeNull();
    expect(shown.hint).not.toContain("ends itself");
    expect(fs.existsSync(idleRecordPath(project, "chrome"))).toBe(false);
    expect(resolveIdleMinutes(0, true)).toBeNull();
    expect(resolveIdleMinutes(undefined, true)).toBe(30);
    expect(resolveIdleMinutes(5, false)).toBe(5);
  });

  it("idleMinutes on a visible window arms the record with that time", async () => {
    const project = tmpProject();
    const limited = JSON.parse(await dev.handler({ wait: false, projectPath: project, headless: false, idleMinutes: 5 }));

    expect(limited.value.idleMinutes).toBe(5);
    expect(limited.hint).toContain("ends itself after 5 minutes");
    expect(JSON.parse(fs.readFileSync(idleRecordPath(project, "chrome"), "utf8")).idleMs).toBe(5 * 60_000);
  });

  it("a tool call naming the project resets the idle clock on its record", async () => {
    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    const before = new Date(Date.now() - 60_000);
    fs.mkdirSync(path.dirname(idleRecordPath(project, "chrome")), { recursive: true });
    fs.writeFileSync(idleRecordPath(project, "chrome"), JSON.stringify({ pid, session: { projectPath: project, browser: "chrome" }, idleMs: 60_000 }));
    fs.utimesSync(idleRecordPath(project, "chrome"), before, before);

    const reads: ToolModule = {
      schema: { name: "extension_wait", description: "fake", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, browser: { type: "string" } }, required: ["projectPath"] } },
      handler: async () => JSON.stringify({ ok: true, status: "ready", value: {} }),
    };
    const dispatch = createToolDispatcher({ tools: [reads], options: { features: ["local"], noShip: false } });
    await dispatch({ name: "extension_wait", arguments: { projectPath: project } });

    expect(fs.statSync(idleRecordPath(project, "chrome")).mtimeMs).toBeGreaterThan(before.getTime() + 30_000);
  });

  it("the watchdog ends an idle session on its own, and the next failing call on it says when it idled out", async () => {
    if (process.platform === "win32") return;

    const project = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: project, command: "dev" });
    const { pollMs, graceMs } = idleClock;
    idleClock.pollMs = 50;
    idleClock.graceMs = 100;

    try {
      expect(armSessionIdle({ projectPath: project, browser: "chrome", pid, idleMinutes: 0.005 })).toBeNull();
    } finally {
      idleClock.pollMs = pollMs;
      idleClock.graceMs = graceMs;
    }

    const deadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(50);

    expect(await waitGone(pid)).toBe(true);
    while (!fs.existsSync(idledOutPath(project, "chrome")) && Date.now() < deadline) await sleep(50);

    const ended = readIdledOut(project, "chrome");
    expect(ended).toMatchObject({ pid, idleMinutes: 0.005, session: { projectPath: path.resolve(project), browser: "chrome" } });
    expect(typeof ended?.idledOutAt).toBe("string");
    expect(fs.existsSync(idleRecordPath(project, "chrome"))).toBe(false);
    expect(listSessionMarkers().map((m) => path.resolve(m.projectPath))).not.toContain(project);
    removeSession(project, "chrome");

    const dispatch = createToolDispatcher({ tools: [stop as unknown as ToolModule], options: { features: ["local"], noShip: false } });
    const frame = await dispatch({ name: "extension_stop", arguments: { projectPath: project, browser: "chrome" } });
    const answer = JSON.parse(frame.content[0]?.text ?? "{}");

    expect(answer.ok).toBe(false);
    expect(answer.warnings.join(" ")).toContain(`ended itself at ${ended?.idledOutAt}`);
    expect(answer.warnings.join(" ")).toContain("no tool call named it for 0.005 minutes");
    expect(fs.existsSync(idledOutPath(project, "chrome"))).toBe(false);
  }, 10_000);
});

describe("922: a dev session that exists and has not compiled yet is starting, for every tool", () => {
  const INSTALLING = "process.stdout.write('Installing the project dependencies with npm\\n'); setTimeout(() => {}, 60000)";
  const SESSION_TOOLS = Object.keys(TOOL_POLICY).filter((name) => TOOL_POLICY[name].liveSession);
  const ran: string[] = [];

  function standIn(name: string): ToolModule {
    return {
      schema: { name, description: "stand-in", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, browser: { type: "string" } }, required: ["projectPath"] } },
      handler: async () => {
        ran.push(name);

        return envelope({ ok: true, command: name, status: "ok", value: {} });
      },
    };
  }

  function stamp(project: string, contract: Record<string, unknown>): void {
    const dir = path.join(project, "dist", "extension-js", "chrome");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(contract));
  }

  async function answerOf(dispatch: ReturnType<typeof createToolDispatcher>, name: string, args: Record<string, unknown>) {
    const frame = await dispatch({ name, arguments: args });

    return JSON.parse(frame.content[0]?.text ?? "{}");
  }

  async function installLineWritten(logPath: string): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (!fs.readFileSync(logPath, "utf8").includes("Installing") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(() => {
    ran.length = 0;
  });

  it("names every session tool, and none of the three an agent calls while it waits", () => {
    expect(SESSION_TOOLS.sort()).toEqual([
      "extension_assert",
      "extension_dom_snapshot",
      "extension_element",
      "extension_eval",
      "extension_inspect",
      "extension_list_extensions",
      "extension_network",
      "extension_open",
      "extension_reload",
      "extension_screenshot",
      "extension_storage",
    ]);
  });

  it("extension_dev answers starting with what it waits on when its ready wait runs out on a live session", async () => {
    const project = tmpProject();
    const cli = fakeCli(INSTALLING);
    nextChild = () => cli;
    real.budgetMs = 1_000;

    try {
      await installLineWritten(cli.logPath);
      const result = JSON.parse(await dev.handler({ projectPath: project, allowEval: true }));

      expect(result.ok).toBe(true);
      expect(result.status).toBe("starting");
      expect(result.value.ready).toMatchObject({ status: "starting", waitingOn: "dependency-install", compiled: false, browserAttached: false, budgetMs: 1_000 });
      expect(result.value.firstLogs).toEqual({ status: "starting" });
      expect(result.value.capabilities.allowEval).toBe(true);
      expect(result.hint).toMatch(/^The session is still starting \(ready\.status: starting, waiting on dependency-install\), not ready: call extension_wait until it answers ready/);
      expect(result.hint).toContain("A first run installs dependencies and can take a couple of minutes.");
    } finally {
      nextChild = () => fakeCli("setTimeout(()=>{}, 60000)");
    }
  }, 15_000);

  it("refuses every session tool with one code while the session starts, and runs them once it is ready", async () => {
    const project = tmpProject();
    const cli = fakeCli(INSTALLING);
    registerSession({ pid: cli.child.pid!, browser: "chrome", projectPath: project, command: "dev", allowEval: true, logPath: cli.logPath });
    await installLineWritten(cli.logPath);

    const dispatch = createToolDispatcher({
      tools: [...SESSION_TOOLS, "extension_wait", "extension_doctor", "extension_stop"].map(standIn),
      options: { features: ["local", "extras"], noShip: false },
    });

    for (const name of SESSION_TOOLS) {
      const answer = await answerOf(dispatch, name, { projectPath: project });

      expect(answer, name).toMatchObject({
        ok: false,
        command: name,
        status: "starting",
        error: { code: "E_SESSION_STARTING", retry: "safe" },
        value: { browser: "chrome", pid: cli.child.pid, waitingOn: "dependency-install" },
      });

      expect(answer.error.message, name).toContain("is still starting: it is installing the project's dependencies");
      expect(answer.error.hint, name).toBe(
        `Call extension_wait with this projectPath and browser: "chrome", then call ${name} again. A first run installs dependencies and can take a couple of minutes. The session exists: do not start or replace it.`,
      );
    }

    expect(ran).toEqual([]);

    for (const name of ["extension_wait", "extension_doctor", "extension_stop"]) {
      expect((await answerOf(dispatch, name, { projectPath: project })).ok, name).toBe(true);
    }

    stamp(project, { status: "starting", command: "dev", browser: "chrome", pid: cli.child.pid });
    expect((await answerOf(dispatch, "extension_open", { projectPath: project })).value.waitingOn).toBe("first-compile");

    stamp(project, readyContract("dev", "chrome", { pid: cli.child.pid }));
    ran.length = 0;

    for (const name of SESSION_TOOLS) {
      expect((await answerOf(dispatch, name, { projectPath: project })).ok, name).toBe(true);
    }

    expect(ran).toEqual(SESSION_TOOLS);
  }, 15_000);

  it("leaves a project with no session, a dead session and a production session to their own answers", async () => {
    const dispatch = createToolDispatcher({ tools: [standIn("extension_open")], options: { features: ["local"], noShip: false } });
    const none = tmpProject();
    const dead = tmpProject();
    const production = tmpProject();
    registerSession({ pid: 2 ** 30, browser: "chrome", projectPath: dead, command: "dev" });
    registerSession({ pid: spawnVictim(), browser: "chrome", projectPath: production, command: "start" });

    for (const project of [none, dead, production]) {
      const answer = await answerOf(dispatch, "extension_open", { projectPath: project });

      expect(answer.ok, JSON.stringify(answer).slice(0, 600)).toBe(true);
    }
  });

  it("extension_logs answers starting while no log file exists, and reads the file once there is one", async () => {
    const project = tmpProject();
    registerSession({ pid: spawnVictim(), browser: "chrome", projectPath: project, command: "dev" });

    const starting = JSON.parse(await real.logs!({ projectPath: project }));

    expect(starting.status).toBe("starting");
    expect(starting.error.code).toBe("E_SESSION_STARTING");
    expect(starting.error.hint).toContain("then call extension_logs again");
    expect(starting.error.hint).not.toMatch(/Start a dev session/);

    const logs = path.join(project, "dist", "extension-js", "chrome", "logs.ndjson");
    fs.mkdirSync(path.dirname(logs), { recursive: true });
    fs.writeFileSync(logs, "");

    expect(JSON.parse(await real.logs!({ projectPath: project })).error?.code).not.toBe("E_SESSION_STARTING");
  });

  it("extension_eval reads allowEval from what the session was started with, and keeps E_EVAL_DISABLED for a session started without it", async () => {
    const allowed = tmpProject();
    const denied = tmpProject();
    const pid = spawnVictim();
    registerSession({ pid, browser: "chrome", projectPath: allowed, command: "dev", allowEval: true });
    registerSession({ pid, browser: "chrome", projectPath: denied, command: "dev", allowEval: false });

    const starting = JSON.parse(await evalTool.handler({ projectPath: allowed, targetId: "T1", expression: "1" }));

    expect(starting.error.code).toBe("E_SESSION_STARTING");
    expect(starting.error.hint).not.toContain("replace: true");

    stamp(allowed, readyContract("dev", "chrome", { pid }));
    stamp(denied, readyContract("dev", "chrome", { pid }));

    const pending = JSON.parse(await evalTool.handler({ projectPath: allowed, targetId: "T1", expression: "1" }));

    expect(pending.status).toBe("control-unavailable");
    expect(pending.error).toMatchObject({ code: "E_CONTROL_UNAVAILABLE", retry: "safe" });
    expect(pending.error.message).toContain("was started with allowEval: true");
    expect(pending.error.hint).toMatch(/^Call extension_wait until the session is ready, then extension_eval again/);
    expect(pending.error.hint).not.toContain("replace: true");

    const disabled = JSON.parse(await evalTool.handler({ projectPath: denied, targetId: "T1", expression: "1" }));

    expect(disabled.error.code).toBe("E_EVAL_DISABLED");
    expect(disabled.error.hint).toContain("replace: true");
  });

  it("945: never says a session was started without allowEval when it was started with it, or when there is no session", async () => {
    const none = tmpProject();
    const ended = tmpProject();
    registerSession({ pid: 2 ** 30, browser: "chrome", projectPath: ended, command: "dev", allowEval: true });
    stamp(ended, readyContract("dev", "chrome", { pid: 2 ** 30 }));

    const absent = JSON.parse(await evalTool.handler({ projectPath: none, targetId: "T1", expression: "1" }));

    expect(absent.status).toBe("no-session");
    expect(absent.error.code).toBe("E_NO_SESSION");
    expect(absent.error.message).toBe("No chrome session is known for this project, so there is nothing to evaluate in.");
    expect(absent.error.hint).toBe("Call extension_dev with allowEval: true, then extension_wait until it is ready, then extension_eval again.");

    const gone = JSON.parse(await evalTool.handler({ projectPath: ended, targetId: "T1", expression: "1" }));

    expect(gone.status).toBe("no-session");
    expect(gone.error.code).toBe("E_NO_SESSION");
    expect(gone.error.message).toBe(`The chrome session this server recorded for this project has ended (pid ${2 ** 30} is gone), so there is nothing to evaluate in.`);
    expect(gone.error.message).not.toContain("without allowEval");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "945: a session started with allowEval whose process cannot be told from a stranger's is told to wait, not to restart",
    async () => {
      const project = tmpProject();
      registerSession({ pid: 1, browser: "chrome", projectPath: project, command: "dev", allowEval: true });

      const answer = JSON.parse(await evalTool.handler({ projectPath: project, context: "page", url: "http://127.0.0.1:4173/docs/start.html?ref=nav", expression: "1" }));

      expect(answer.error.code).not.toBe("E_EVAL_DISABLED");
      expect(answer.error).toMatchObject({ code: "E_CONTROL_UNAVAILABLE", retry: "safe" });
      expect(answer.error.message).toContain("was started with allowEval: true");
      expect(answer.error.hint).not.toContain("replace: true");
    },
  );
});

describe("948: extension_dev and extension_start settle the install before they run the engine", () => {
  const COLD = JSON.stringify({ name: "cold", devDependencies: { extension: "latest" } });

  function holdInstall(project: string, pid: number): void {
    const file = installRecordPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projectRoot: project, since: new Date().toISOString(), holders: [{ pid, startedAt: processStartedAt(pid), role: "engine" }] }));
  }

  beforeEach(() => {
    spawnCount = 0;
    installRuns.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["extension_dev", () => dev.handler, "extension_dev"],
    ["extension_start", () => start.handler, "extension_start"],
  ] as const)("%s starts no session while an install runs, and answers installing as progress with the call to repeat", async (_label, tool, command) => {
    const project = tmpProject();
    const pid = spawnVictim();
    fs.writeFileSync(path.join(project, "package.json"), COLD);
    holdInstall(project, pid);
    vi.useFakeTimers({ toFake: ["Date"] });

    const clock = setInterval(() => vi.setSystemTime(Date.now() + 31_000), 100);
    const result = JSON.parse(await tool()({ wait: false, projectPath: project }).finally(() => clearInterval(clock)));

    expect(spawnCount).toBe(0);
    expect(result).toMatchObject({ ok: true, command, status: "installing", error: null });
    expect(result.value).toMatchObject({ started: false, waitingOn: "dependency-install", installPid: pid, retry: "safe" });
    expect(result.hint).toMatch(
      new RegExp(
        `^No session was started: the engine an earlier extension_build call left running \\(pid ${pid}\\) is still installing this project's dependencies, and this call waited [0-9.]+ s for it to end\\. Call ${command} again with the same arguments: it waits for this install to end, then starts the session\\. Do not start an install by hand and do not poll the process table; the next call does the waiting\\.$`,
      ),
    );
  }, 20_000);

  it("extension_start on a project with no node_modules hands the record to its session until the engine stamps ready.json", async () => {
    const project = tmpProject();
    fs.writeFileSync(path.join(project, "package.json"), COLD);

    const answer = start.handler({ wait: false, projectPath: project });

    await vi.waitFor(() => expect(spawnCount).toBe(1));

    const pid = spawned[spawned.length - 1].pid as number;

    await vi.waitFor(() => expect(runningInstall(project)).toEqual({ pid, owner: "session", browser: "chrome" }));

    const ready = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    fs.mkdirSync(path.dirname(ready), { recursive: true });
    fs.writeFileSync(ready, JSON.stringify(readyContract("start", "chrome", { pid })));

    expect(runningInstall(project)).toBeNull();
    expect(JSON.parse(await answer).ok).toBe(true);
  }, 20_000);

  it("extension_dev reruns an install left without the engine binary before it starts the session", async () => {
    const project = tmpProject();
    fs.writeFileSync(path.join(project, "package.json"), COLD);
    fs.mkdirSync(path.join(project, "node_modules", "extension"), { recursive: true });

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(installRuns).toEqual([project]);
    expect(result.status).toBe("started");
    expect(spawnCount).toBe(1);
  });
});
