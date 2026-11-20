import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, it, expect, afterEach, afterAll } from "vitest";

import * as stop from "../tools/stop";
import {
  registerSession,
  removeSession,
  listSessionMarkers,
  listSessions,
} from "../lib/process-manager";
import { resolveExtensionInvocation } from "../lib/exec";
import { PLAUSIBLE_SESSION_BINARY, commandLineNames, linuxStartFromStat, pidState, processCommand, processStartedAt } from "../lib/process-identity";
import { liveNetworkStubs, openNetworkStubs, stubLinks } from "../lib/network-stubs";
import { liveProjectSessions } from "../lib/session-browser";
import { readyContract } from "./fixtures/engine-answers";

const inMemorySession = (projectPath: string, browser: string) =>
  listSessions().find(
    (s) => path.resolve(s.projectPath) === path.resolve(projectPath) && s.browser === browser,
  );

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

    await new Promise((resolve) => setTimeout(resolve, 50));
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
  it("answers no-session, not bad-request, when nothing is live and no projectPath is named", async () => {
    const result = JSON.parse(await stop.handler({}));
    expect(result.ok).toBe(false);
    expect(result.status).toBe("no-session");
    expect(result.error.code).toBe("E_NO_SESSION");
    expect(result.value.sessions).toEqual([]);
  });

  it("reports when no session is known", async () => {
    const result = JSON.parse(
      await stop.handler({ projectPath: tmpProject(), browser: "chrome" }),
    );
    expect(result.value.stopped).toBe(false);
    expect(result.value.pid).toBeNull();
  });

  it("912: answers a project with no session as E_NO_SESSION with what to pass instead, never ok: false with no error", async () => {
    const result = JSON.parse(await stop.handler({ projectPath: tmpProject(), browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("not-found");
    expect(result.error.code).toBe("E_NO_SESSION");
    expect(result.error.message).toMatch(/^No known session for this project\/browser/);
    expect(result.error.hint).toBe("Nothing was stopped. If the session runs from another folder or browser, pass that projectPath and browser; all: true sweeps every session recorded on this machine.");
    expect(result.error.retry).toBe("no");
  });

  it("takes the session's network stub rules down with it, even when no pid is on record", async () => {
    const projectPath = tmpProject();
    const originalOpen = stubLinks.open;
    let disconnected = 0;
    stubLinks.open = async () => ({
      sendCommand: async () => ({}),
      onEvent: () => () => undefined,
      onClose: () => undefined,
      disconnect: () => {
        disconnected += 1;
      },
    });

    try {
      const stubs = await openNetworkStubs(projectPath, "chrome", 9222);
      await stubs.add({ id: "stub-1", method: "ANY", url: "https://api.example.com/*", status: 500, body: "", contentType: "text/plain", headers: {}, hits: 0 });
      expect(liveNetworkStubs(projectPath, "chrome")).toHaveLength(1);

      await stop.handler({ projectPath, browser: "chrome" });

      expect(liveNetworkStubs(projectPath, "chrome")).toEqual([]);
      expect(disconnected).toBe(1);
    } finally {
      stubLinks.open = originalOpen;
    }
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
    expect(await waitGone(pid)).toBe(true);
    expect(inMemorySession(projectPath, "chrome")).toBeUndefined();
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
    expect(await waitGone(pid)).toBe(true);
  });

  it("falls back to the ready.json contract when the registry is empty", async () => {
    const projectPath = tmpProject();
    const pid = spawnVictim();
    const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
    fs.mkdirSync(readyDir, { recursive: true });
    const readyPath = path.join(readyDir, "ready.json");
    fs.writeFileSync(
      readyPath,
      JSON.stringify(readyContract("dev", "chrome", { pid, distPath: path.join(projectPath, "dist", "chrome") })),
    );

    const result = JSON.parse(
      await stop.handler({ projectPath, browser: "chrome" }),
    );

    expect(result.value.pid).toBe(pid);
    expect(result.value.stopped).toBe(true);
    expect(await waitGone(pid)).toBe(true);
    expect(fs.existsSync(readyPath)).toBe(false);
  });

  it("stops everything with all=true once confirm: true carries the cross-project stop", async () => {
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

    const result = JSON.parse(await stop.handler({ all: true, confirm: true }));
    expect(result.status).toBe("stopped-all");
    const stoppedPids = result.value.stopped.map((o: { pid: number }) => o.pid);
    expect(stoppedPids).toContain(pidA);
    expect(stoppedPids).toContain(pidB);
    expect(await waitGone(pidA)).toBe(true);
    expect(await waitGone(pidB)).toBe(true);
  }, 15_000);
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
    expect(await waitGone(pid)).toBe(true);
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

function profileDirAsTheLauncherWritesIt(
  projectPath: string,
  browser: string,
  runName: string,
): string {
  return path.join(
    projectPath,
    "dist",
    "extension-js",
    "profiles",
    `${browser}-profile`,
    runName,
  );
}

describe("extension_stop orphan reaping", () => {
  it(
    "reaps a profile-dir holder even when the project path carries regex metachars",
    async () => {
      const projectPath = path.join(tmpProject(), "weird (c++) [v1]");
      fs.mkdirSync(projectPath, { recursive: true });
      const holderArg = profileDirAsTheLauncherWritesIt(
        projectPath,
        "chrome",
        "tidy-amber-otter",
      );
      const pid = spawnHolder(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
        holderArg,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));

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
        profileDirAsTheLauncherWritesIt(projectPath, "chrome", "tidy-amber-otter"),
        "session.log",
      );
      fs.mkdirSync(path.dirname(watched), { recursive: true });
      fs.writeFileSync(watched, "log line\n");
      const pid = spawnHolder("tail", ["-f", watched]);
      await new Promise((resolve) => setTimeout(resolve, 200));

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

  it(
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
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = JSON.parse(
        await stop.handler({ projectPath: relative, browser: "chrome" }),
      );

      expect(result.value.reaped).toContain(pid);
      expect(await waitGone(pid)).toBe(true);
    },
    15_000,
  );

  it.each([
    {
      neighbor: "an engine on a sibling folder whose path starts with this project's",
      argv: (projectPath: string) => ["extension", "dev", `${projectPath}-2`, "--browser", "chrome"],
    },
    {
      neighbor: "a profile holder under a folder whose path ends with this project's",
      argv: (projectPath: string) => [profileDirAsTheLauncherWritesIt(path.join(tmpProject(), projectPath), "chrome", "tidy-amber-otter")],
    },
  ])(
    "leaves $neighbor running",
    async ({ argv }) => {
      const projectPath = path.join(tmpProject(), "app");
      fs.mkdirSync(projectPath, { recursive: true });
      const pid = spawnHolder(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...argv(projectPath)]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(isAlive(pid)).toBe(true);

      try {
        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(isAlive(pid)).toBe(true);
        expect(result.value.reaped).toEqual([]);
        expect(result.error.code).toBe("E_NO_SESSION");
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
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

describe("extension_stop never signals a pid that is no longer the session", () => {
  posixOnly(
    "cleans the records and kills nothing when the recorded pid is now a stranger",
    async () => {
      const projectPath = tmpProject();
      const stranger = spawnHolder("sleep", ["300"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
      fs.mkdirSync(readyDir, { recursive: true });
      fs.writeFileSync(
        path.join(readyDir, "ready.json"),
        JSON.stringify(readyContract("dev", "chrome", { pid: stranger, pidStartedAt: undefined, browserPid: null, launcherPid: null, distPath: path.join(projectPath, "dist", "chrome") })),
      );

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(isAlive(stranger)).toBe(true);
      expect(result.value.reaped).toEqual([]);
      expect(result.value.detail).toContain("Nothing was signalled");
      expect(result.value.detail).toContain('"sleep"');
      expect(result.value.staleRecord).toBe(true);
      expect(result.error.code).toBe("E_NO_SESSION");
      expect(fs.existsSync(path.join(readyDir, "ready.json"))).toBe(false);

      try {
        process.kill(stranger, "SIGKILL");
      } catch {
      }
    },
    15_000,
  );

  posixOnly(
    "943: keeps the records of a session whose recorded browser is still alive beside a stranger PID",
    async () => {
      const projectPath = tmpProject();
      const stranger = spawnHolder("sleep", ["300"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
      fs.mkdirSync(readyDir, { recursive: true });
      fs.writeFileSync(
        path.join(readyDir, "ready.json"),
        JSON.stringify(readyContract("dev", "chrome", { pid: stranger, pidStartedAt: undefined, browserPid: process.pid, launcherPid: null, distPath: path.join(projectPath, "dist", "chrome") })),
      );

      try {
        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(isAlive(stranger)).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.status).toBe("still-alive");
        expect(result.error.code).toBe("E_STOP_INCOMPLETE");
        expect(result.value.stopped).toBe(false);
        expect(result.value.browserGone).toBe(false);
        expect(result.value.staleRecord).toBeUndefined();
        expect(result.value.detail).toContain("Nothing was signalled");
        expect(result.value.detail).toContain("The session's records were kept");
        expect(result.value.detail).toContain(`the browser the launcher recorded (pid ${process.pid}) is still alive`);
        expect(result.value.detail).not.toContain("stale records were removed");
        expect(result.error.hint).toContain(`Pid ${stranger} is not this session's process`);
        expect(result.error.hint).not.toMatch(/ask the person to end it|still reports alive/);
        expect(result.error.hint).toMatch(/call extension_stop with the same projectPath and browser again\.$/);
        expect(fs.existsSync(path.join(readyDir, "ready.json"))).toBe(true);
      } finally {
        try {
          process.kill(stranger, "SIGKILL");
        } catch {
        }
      }
    },
    15_000,
  );

  posixOnly(
    "never offers a stranger PID for ending when the survivor search cannot run, and clears the records once that PID exits",
    async () => {
      const projectPath = tmpProject();
      const stranger = spawnHolder("sleep", ["300"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
      const readyPath = path.join(readyDir, "ready.json");
      fs.mkdirSync(readyDir, { recursive: true });
      fs.writeFileSync(
        readyPath,
        JSON.stringify(readyContract("dev", "chrome", { pid: stranger, pidStartedAt: undefined, browserPid: null, launcherPid: null, distPath: path.join(projectPath, "dist", "chrome") })),
      );

      const psOnlyBin = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ps-only-"));
      const previousPath = process.env.PATH;
      fs.symlinkSync(fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps", path.join(psOnlyBin, "ps"));
      process.env.PATH = psOnlyBin;

      try {
        const first = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        if (process.platform === "linux") {
          expect(first.value.survivorsUnverified).toBeUndefined();
          expect(first.error.code).toBe("E_NO_SESSION");

          return;
        }

        const second = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        for (const result of [first, second]) {
          expect(result.error.code).toBe("E_STOP_INCOMPLETE");
          expect(result.value.pid).toBe(stranger);
          expect(result.value.survivorsUnverified).toBe(true);
          expect(result.error.hint).toContain(`Pid ${stranger} is not this session's process`);
          expect(result.error.hint).not.toMatch(/ask the person to end it|still reports alive|extension_stop with the same projectPath and browser again/);
          expect(result.error.hint).toMatch(/call extension_dev with this projectPath and browser/);
        }

        expect(isAlive(stranger)).toBe(true);
        expect(fs.existsSync(readyPath)).toBe(true);
        expect(liveProjectSessions(projectPath)).toEqual([]);

        process.kill(stranger, "SIGKILL");
        expect(await waitGone(stranger)).toBe(true);

        const after = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(after.value.detail).toContain("Process was already gone");
        expect(fs.existsSync(readyPath)).toBe(false);
      } finally {
        process.env.PATH = previousPath;
        fs.rmSync(psOnlyBin, { recursive: true, force: true });

        try {
          process.kill(stranger, "SIGKILL");
        } catch {
        }
      }
    },
    20_000,
  );

  posixOnly(
    "943: ends a recorded PID under a name it does not know when the command line names this session",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnHolder("perl", ["-e", "sleep 300", "extension@latest", "dev", projectPath, "--browser=chrome"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
      fs.mkdirSync(readyDir, { recursive: true });
      fs.writeFileSync(
        path.join(readyDir, "ready.json"),
        JSON.stringify(readyContract("dev", "chrome", { pid, pidStartedAt: undefined, browserPid: null, launcherPid: null, distPath: path.join(projectPath, "dist", "chrome") })),
      );

      try {
        expect(pidState(pid)).toBe("foreign");

        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(result.ok).toBe(true);
        expect(result.status).toBe("stopped");
        expect(result.value.stopped).toBe(true);
        expect(result.value.serverGone).toBe(true);
        expect(result.value.detail).toContain("Terminated");
        expect(result.value.detail).not.toContain("Nothing was signalled");
        expect(await waitGone(pid)).toBe(true);
        expect(fs.existsSync(path.join(readyDir, "ready.json"))).toBe(false);
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
        }
      }
    },
    15_000,
  );

  posixOnly(
    "943: leaves a stranger alone when its command line names another browser's session of the project",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnHolder("perl", ["-e", "sleep 300", "extension@latest", "dev", projectPath, "--browser=firefox"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
      fs.mkdirSync(readyDir, { recursive: true });
      fs.writeFileSync(
        path.join(readyDir, "ready.json"),
        JSON.stringify(readyContract("dev", "chrome", { pid, pidStartedAt: undefined, browserPid: null, launcherPid: null, distPath: path.join(projectPath, "dist", "chrome") })),
      );

      try {
        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(isAlive(pid)).toBe(true);
        expect(result.value.detail).toContain("Nothing was signalled");
        expect(result.value.detail).toContain('"perl"');
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
        }
      }
    },
    15_000,
  );

  it.each([
    {
      evidence: "the start time the engine stamped is not this process's",
      stamp: "2026-11-01T10:00:00.000Z",
      says: "not the session process started at 2026-11-01T10:00:00.000Z",
    },
    {
      evidence: "the contract carries no start time and was written before this process began",
      stamp: undefined,
      says: "after the ready contract that names it was last written",
    },
  ])(
    "leaves a session-named process alone when a contract with no session record names its PID and $evidence",
    async ({ stamp, says }) => {
      const projectPath = tmpProject();
      const stranger = spawnHolder(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const readyDir = path.join(projectPath, "dist", "extension-js", "chrome");
      const readyPath = path.join(readyDir, "ready.json");
      fs.mkdirSync(readyDir, { recursive: true });
      fs.writeFileSync(
        readyPath,
        JSON.stringify(readyContract("dev", "chrome", { pid: stranger, pidStartedAt: stamp, browserPid: null, launcherPid: null, distPath: path.join(projectPath, "dist", "chrome") })),
      );

      const lastBoot = new Date(Date.now() - 19 * 24 * 60 * 60 * 1000);
      fs.utimesSync(readyPath, lastBoot, lastBoot);

      try {
        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(isAlive(stranger)).toBe(true);
        expect(result.value.detail).toContain("nothing was signalled");
        expect(result.value.detail).toContain(says);
        expect(result.value.detail).not.toContain("Terminated");
        expect(fs.existsSync(readyPath)).toBe(false);
      } finally {
        try {
          process.kill(stranger, "SIGKILL");
        } catch {
        }
      }
    },
    15_000,
  );
});

describe("extension_stop says when it could not look for survivors", () => {
  posixOnly(
    "949: reads the survivors from /proc on Linux when pgrep cannot run, and elsewhere reports them as unverified, not absent",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnVictim();
      registerSession({ pid, browser: "chrome", projectPath, command: "dev" });
      const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-no-pgrep-"));
      const previousPath = process.env.PATH;
      process.env.PATH = emptyBin;
      let result: any;

      try {
        result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));
      } finally {
        process.env.PATH = previousPath;
        fs.rmSync(emptyBin, { recursive: true, force: true });
      }

      if (process.platform === "linux") {
        expect(result.ok).toBe(true);
        expect(result.status).toBe("stopped");
        expect(result.value.stopped).toBe(true);
        expect(result.value.survivorsUnverified).toBeUndefined();
        expect(await waitGone(pid)).toBe(true);

        return;
      }

      expect(result.ok).toBe(false);
      expect(result.value.survivorsUnverified).toBe(true);
      expect(result.value.detail).toContain("NOT verified");
      expect(result.value.serverGone).toBe(true);
      expect(result.error.hint).not.toMatch(/still reports alive|ask the person to end it/);
      expect(result.error.hint).toMatch(/Ask the person whether the session's browser window is still open/);
    },
    15_000,
  );
});

describe("extension_stop with a browser ends only that browser's session", () => {
  const holdForever = ["-e", "setInterval(() => {}, 1000)"];

  async function stopFirefoxBesideChrome(
    chromeArgv: (projectPath: string) => string[],
    firefoxArgv: (projectPath: string) => string[],
  ): Promise<{ chrome: number; firefox: number; result: any }> {
    const projectPath = tmpProject();
    const chrome = spawnHolder(process.execPath, [...holdForever, ...chromeArgv(projectPath)]);
    const firefox = spawnHolder(process.execPath, [...holdForever, ...firefoxArgv(projectPath)]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
      const result = JSON.parse(await stop.handler({ projectPath, browser: "firefox" }));

      return { chrome, firefox, result };
    } catch (error) {
      for (const pid of [chrome, firefox]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }

      throw error;
    }
  }

  async function expectChromeKept(outcome: { chrome: number; firefox: number; result: any }) {
    try {
      expect(outcome.result.value.reaped).toContain(outcome.firefox);
      expect(await waitGone(outcome.firefox)).toBe(true);
      expect(outcome.result.value.reaped).not.toContain(outcome.chrome);
      expect(isAlive(outcome.chrome)).toBe(true);
    } finally {
      for (const pid of [outcome.chrome, outcome.firefox]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    }
  }

  posixOnly(
    "keeps a chrome dev server alive when the project's firefox session is stopped",
    async () => {
      await expectChromeKept(
        await stopFirefoxBesideChrome(
          (projectPath) => ["extension", "dev", projectPath, "--browser", "chrome", "--allow-control"],
          (projectPath) => ["extension", "preview", projectPath, "--browser", "firefox", "--allow-control"],
        ),
      );
    },
    15_000,
  );

  posixOnly(
    "keeps a browser on the chrome managed profile alive when firefox is stopped",
    async () => {
      await expectChromeKept(
        await stopFirefoxBesideChrome(
          (projectPath) => [profileDirAsTheLauncherWritesIt(projectPath, "chrome", "dev")],
          (projectPath) => [profileDirAsTheLauncherWritesIt(projectPath, "firefox", "dev")],
        ),
      );
    },
    15_000,
  );
});

describe("extension_stop judges a session by its pid and its start time", () => {
  function spawnHeldVictim(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return child;
  }

  it(
    "reports a pid whose start time no longer matches the record as gone and signals nothing",
    async () => {
      const projectPath = tmpProject();
      const child = spawnHeldVictim();
      const pid = child.pid!;

      try {
        registerSession({
          pid,
          processStartedAt: "2001-01-01T00:00:00.000Z",
          browser: "chrome",
          projectPath,
          command: "dev",
        });

        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(result.status).toBe("stopped");
        expect(result.value.stopped).toBe(true);
        expect(result.value.staleRecord).toBeUndefined();
        expect(result.value.detail).toContain("Process was already gone");
        expect(result.value.detail).toContain(`pid ${pid} now belongs to a process started at`);
        expect(result.value.detail).not.toContain("Terminated");
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(isAlive(pid)).toBe(true);
        expect(inMemorySession(projectPath, "chrome")).toBeUndefined();
      } finally {
        child.kill("SIGKILL");
      }
    },
    15_000,
  );

  it(
    "records the start time of the process it registers and ends that process",
    async () => {
      const projectPath = tmpProject();
      const pid = spawnVictim();
      registerSession({ pid, browser: "chrome", projectPath, command: "dev" });

      const recorded = inMemorySession(projectPath, "chrome")?.processStartedAt;
      expect(typeof recorded).toBe("string");
      expect(Math.abs(Date.parse(recorded!) - Date.now())).toBeLessThan(60_000);
      const marker = listSessionMarkers().find(
        (m) => path.resolve(m.projectPath) === path.resolve(projectPath) && m.browser === "chrome",
      );
      expect(marker?.processStartedAt).toBe(recorded);
      expect(pidState(pid, recorded)).toBe("alive");

      const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

      expect(result.value.stopped).toBe(true);
      expect(result.value.detail).toContain("Terminated");
      expect(await waitGone(pid)).toBe(true);
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "937: ends a session process that names itself MainThread when its start time matches the record",
    async () => {
      const projectPath = tmpProject();
      const renamed = path.join(projectPath, "MainThread");
      fs.symlinkSync(process.execPath, renamed);
      const child = spawn(renamed, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      child.unref();
      const pid = child.pid!;

      try {
        const recorded = processStartedAt(pid);
        expect(typeof recorded).toBe("string");
        expect(path.basename(processCommand(pid))).toBe("MainThread");
        expect(pidState(pid, recorded)).toBe("alive");
        expect(pidState(pid, "2001-01-01T00:00:00.000Z")).toBe("dead");
        if (process.platform === "linux") expect(pidState(pid)).toBe("alive");

        registerSession({ pid, browser: "chrome", projectPath, command: "dev" });

        const result = JSON.parse(await stop.handler({ projectPath, browser: "chrome" }));

        expect(result.ok).toBe(true);
        expect(result.value.stopped).toBe(true);
        expect(result.value.detail).toContain("Terminated");
        expect(result.value.detail).not.toContain("MainThread");
        expect(await waitGone(pid)).toBe(true);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "943: reads a process npm exec retitled as a session process, with a recorded start time and without one",
    async () => {
      const title = "npm exec extension@latest dev /work --starting-url=http://127.0.0.1:4173/docs/start.html?ref=nav --allow-control --allow-eval";
      const child = spawn(
        process.execPath,
        ["-e", `process.title = ${JSON.stringify(title)}; setInterval(() => {}, 1000)`, "x".repeat(240)],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      const pid = child.pid!;

      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const recorded = processStartedAt(pid);
        expect(typeof recorded).toBe("string");
        expect(pidState(pid, recorded)).toBe("alive");
        expect(pidState(pid, "2001-01-01T00:00:00.000Z")).toBe("dead");
        expect(pidState(pid)).toBe("alive");
        if (process.platform === "linux") expect(processCommand(pid)).toBe("npm");

        expect(commandLineNames(`${title}\0\0\0`)).toEqual(["npm", "start.html?ref=nav --allow-control --allow-eval"]);
        expect(commandLineNames("/opt/google/chrome/chrome\0--type=renderer\0--lang=en US\0")).toEqual(["chrome"]);
        expect(commandLineNames("/opt/My Browser/chrome\0")).toEqual(["My", "chrome"]);
        expect(commandLineNames("\0")).toEqual([]);
        expect(PLAUSIBLE_SESSION_BINARY.test("npm exec extens")).toBe(true);
        expect(PLAUSIBLE_SESSION_BINARY.test("npx")).toBe(true);
        expect(PLAUSIBLE_SESSION_BINARY.test("sleep")).toBe(false);
        expect(PLAUSIBLE_SESSION_BINARY.test("pnpm-lock-watcher")).toBe(false);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    },
    20_000,
  );

  it("949: reads a start time from the kernel's stat line, whatever the process calls itself, and on Linux with no ps on the PATH", () => {
    const boot = Date.parse("2026-11-18T00:00:00.000Z");

    expect(linuxStartFromStat("57 (npm exec extens) S 1 57 57 0 -1 4194304 900 0 0 0 12 3 0 0 20 0 11 0 360000 1 2 3", boot)).toBe("2026-11-18T01:00:00.000Z");
    expect(linuxStartFromStat("58 (Web Content) (x) R 1 58 58 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 150 1 2 3", boot)).toBe("2026-11-18T00:00:01.500Z");
    expect(linuxStartFromStat("59 (node) S 1 59", boot)).toBeNull();

    if (process.platform !== "linux") return;

    const withPs = processStartedAt(process.pid);
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-no-ps-"));
    const previousPath = process.env.PATH;
    process.env.PATH = emptyBin;

    try {
      const fromProc = processStartedAt(process.pid);

      expect(typeof fromProc).toBe("string");
      if (withPs) expect(Math.abs(Date.parse(fromProc!) - Date.parse(withPs))).toBeLessThanOrEqual(2_000);

      expect(pidState(process.pid, fromProc)).toBe("alive");
      expect(pidState(process.pid, "2001-01-01T00:00:00.000Z")).toBe("dead");
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it("calls this process dead under a start time it never had and alive under its own", () => {
    expect(pidState(process.pid, "2001-01-01T00:00:00.000Z")).toBe("dead");
    expect(pidState(process.pid, processStartedAt(process.pid))).toBe("alive");
    expect(pidState(process.pid)).toBe("alive");
  });

  it.skipIf(process.platform === "win32")("739: a pid the process table refuses is read without a word on stderr", () => {
    const identity = pathToFileURL(path.resolve(__dirname, "../lib/process-identity.ts")).href;
    const script = `import { processCommand, processStartTimes } from ${JSON.stringify(identity)};
      const asked = [4100002, 99999999999];
      process.stdout.write(JSON.stringify({ found: processStartTimes(asked).size, commands: asked.map(processCommand) }));`;
    const ran = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });

    expect(ran.stderr).toBe("");
    expect(JSON.parse(ran.stdout)).toEqual({ found: 0, commands: ["", ""] });
  }, 20_000);
});
