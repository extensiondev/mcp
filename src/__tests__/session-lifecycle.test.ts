import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";

import { readyContract } from "./fixtures/engine-answers";
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

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => nextChild(),
  };
});

const waitCalls: Array<Record<string, unknown>> = [];
const logsCalls: Array<Record<string, unknown>> = [];
let waitAnswer = (): string =>
  JSON.stringify({ ok: true, status: "ready", value: { compiled: true, browserAttached: true, guestLoaded: true } });
const readyAnswer = waitAnswer;

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async (args: Record<string, unknown>) => {
      waitCalls.push(args);

      return waitAnswer();
    },
  };
});

vi.mock("../tools/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof LogsModule>();

  return {
    ...actual,
    handler: async (args: Record<string, unknown>) => {
      logsCalls.push(args);

      return JSON.stringify({ ok: true, status: "ok", value: { count: 2, lines: ["[background] hello", "[newtab] hello"] } });
    },
  };
});

const dev = await import("../tools/dev");
const stop = await import("../tools/stop");
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
    await new Promise((r) => setTimeout(r, 200));
    registerSession({ pid: stranger.pid!, browser: "chrome", projectPath: project, command: "dev" });

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
    expect(isAlive(pid)).toBe(false);
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
    expect(isAlive(chromePid)).toBe(false);
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
    await new Promise((r) => setTimeout(r, 200));
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
    expect(isAlive(pid)).toBe(false);
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

    expect(isAlive(pid)).toBe(false);
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
