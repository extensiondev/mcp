// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";
import type * as WaitModule from "../tools/wait";
import type * as LogsModule from "../tools/logs";

const spawned: ChildProcess[] = [];

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
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

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => fakeCli(),
  };
});

const undiagnosed = (): string =>
  JSON.stringify({ ok: false, status: "compiled-not-attached", value: { compiled: true, browserAttached: false } });

let waitAnswer = undiagnosed;

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async () => waitAnswer(),
  };
});

vi.mock("../tools/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof LogsModule>();

  return {
    ...actual,
    handler: async () => JSON.stringify({ ok: true, status: "ok", value: { count: 0, lines: [] } }),
  };
});

const dev = await import("../tools/dev");
const { NO_ATTACH_DIAGNOSIS_NOTE } = await import("../lib/compiled-not-attached");
const { removeSession, removeSessionMarker } = await import("../lib/process-manager");

const PROFILE = "/tmp/pii-shield/dist/extension-profile-chrome";
const FRESH = `${PROFILE}-fresh-202610240139`;
const HINT =
  "Chrome (pid 66462) is up, but the extension has not connected after 15 s.\n" +
  `Profile ${PROFILE} had been run before: a profile picker, a restore prompt or a stale copy of the extension in it can keep the extension from connecting.\n` +
  "Dismiss any dialog there, or stop this session and run again on a fresh profile (delete that folder, or pass --profile <new path>).";
const WAY_OUT = `Relaunch on a fresh profile: call extension_dev with replace: true and profile: "${FRESH}".`;

function diagnosed(projectPath: string): string {
  return JSON.stringify({
    ok: false,
    status: "compiled-not-attached",
    value: {
      compiled: true,
      browserAttached: false,
      browserPid: 66462,
      profilePath: PROFILE,
      profileReused: true,
      waitedMs: 15_000,
      browserUpNotAttachedAt: "2026-10-24T01:39:15.000Z",
      browserUpNotAttachedHint: HINT,
      budgetMs: 45_000,
      elapsedMs: 0,
      sayToPerson: `${HINT} ${WAY_OUT}`,
      nextStep: {
        kind: "relaunch",
        tool: "extension_dev",
        args: { projectPath, browser: "chrome", replace: true, profile: FRESH },
        say: WAY_OUT,
      },
    },
  });
}

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-not-attached-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  waitAnswer = undiagnosed;

  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    for (const browser of ["chrome", "safari"]) {
      try {
        removeSession(dir, browser);
        removeSessionMarker(dir, browser);
      } catch {
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev relays the engine's attach diagnosis instead of a generic not-attached answer", () => {
  it("answers compiled-not-attached with the hint, the profile facts and the fresh-profile relaunch hoisted out of the wait", async () => {
    const project = tmpProject();

    waitAnswer = () => diagnosed(project);

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.value).toMatchObject({
      browserUpNotAttachedHint: HINT,
      profilePath: PROFILE,
      profileReused: true,
      browserPid: 66462,
      waitedMs: 15_000,
    });

    expect(result.value.nextStep.tool).toBe("extension_dev");
    expect(result.value.nextStep.args).toEqual({ projectPath: project, browser: "chrome", replace: true, profile: FRESH });
    expect(result.value.sayToPerson.startsWith(HINT)).toBe(true);
    expect(result.value.sayToPerson).toContain(WAY_OUT);
    expect(result.hint.startsWith(HINT)).toBe(true);
    expect(result.hint).toContain(WAY_OUT);
    expect(result.value.ready.status).toBe("compiled-not-attached");
    expect(result.value.firstLogs).toBeDefined();
    expect(typeof result.value.pid).toBe("number");
    expect(result.hint).not.toContain(NO_ATTACH_DIAGNOSIS_NOTE);
  }, 15_000);

  it("keeps the started answer for an engine that stamps no diagnosis and says the engine reports none", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.value.ready.status).toBe("compiled-not-attached");
    expect(result.value.browserUpNotAttachedHint).toBeUndefined();
    expect(result.hint).toContain("call extension_wait to keep waiting on the same contract");
    expect(result.hint).toContain(NO_ATTACH_DIAGNOSIS_NOTE);
  }, 15_000);

  it("leaves the Safari not-enabled sentence alone, since the cause there is already named", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ projectPath: project, browser: "safari" }));

    expect(result.status).toBe("started");
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).not.toContain(NO_ATTACH_DIAGNOSIS_NOTE);
  }, 15_000);
});
