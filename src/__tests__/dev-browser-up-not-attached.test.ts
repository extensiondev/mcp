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
const onSpawn = vi.hoisted(() => ({ write: null as null | (() => void), replaced: [] as Array<{ pid: number; browser: string; controlPort?: number }> }));

vi.mock("../lib/boot-verdict", async (importOriginal) =>
  (await import("./fixtures/short-boot")).shortBootWindow(await importOriginal()),
);

vi.mock("node:timers/promises", async (importOriginal) =>
  (await import("./fixtures/short-boot")).shortSleeps(await importOriginal()),
);

vi.mock("../lib/same-browser-session", () => ({
  guardSameBrowserSession: async () => ({ replaced: onSpawn.replaced }),
}));

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);
  onSpawn.write?.();

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
const { NO_ATTACH_DIAGNOSIS_NOTE, REBUILD_NOT_REACHING_NOTE } = await import("../lib/compiled-not-attached");
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
  onSpawn.write = null;
  onSpawn.replaced = [];

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
      profilePath: PROFILE,
      profileReused: true,
      browserPid: 66462,
      waitedMs: 15_000,
    });

    expect(result.value.nextStep.tool).toBe("extension_dev");
    expect(result.value.nextStep.args).toEqual({ projectPath: project, browser: "chrome", replace: true, profile: FRESH });
    expect(result.hint.startsWith(HINT)).toBe(true);

    const raw = JSON.stringify(result);
    const copies = (text: string) => raw.split(JSON.stringify(text).slice(1, -1)).length - 1;

    expect(copies(HINT)).toBe(1);
    expect(copies(WAY_OUT)).toBe(1);
    expect(result.hint).toContain(WAY_OUT);
    expect(result.value.ready.status).toBe("compiled-not-attached");
    expect(result.value.firstLogs).toBeDefined();
    expect(typeof result.value.pid).toBe("number");
    expect(result.hint).not.toContain(NO_ATTACH_DIAGNOSIS_NOTE);
  }, 15_000);

  it("relays the branded Chrome refusal the wait read, not the engine's profile picker sentence", async () => {
    const project = tmpProject();
    const refusal = { extensionId: "kgdaecdpfkikjncaalnmmnjjfpofkcbl", state: "DISABLED", disableReasons: ["unsupportedDeveloperExtension"], browserVersion: "Chrome/158.0.8127.88", developerModeTurnedOn: false, stateAfter: null };
    const binary = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    const chromium = `Relaunch on Chromium under the same target, which keeps dist/chrome and files captures into the chrome set: call extension_dev with replace: true and chromiumBinary: "${binary}".`;

    waitAnswer = () => {
      const answer = JSON.parse(diagnosed(project));
      answer.value.unpackedRefusal = refusal;
      answer.value.nextStep = { kind: "relaunch", tool: "extension_dev", args: { projectPath: project, browser: "chrome", replace: true, chromiumBinary: binary }, say: chromium };

      return JSON.stringify(answer);
    };

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.message).toContain("the browser turned the extension off");
    expect(result.hint).not.toContain("profile picker");
    expect(result.hint).toContain("Chrome 158.0.8127.88 turned this unpacked extension off");
    expect(result.hint).toContain(chromium);
    expect(result.value.unpackedRefusal).toEqual(refusal);
    expect(result.value.nextStep.args.chromiumBinary).toBe(binary);
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
    expect(result.hint).toContain(REBUILD_NOT_REACHING_NOTE);
  }, 15_000);

  it("leaves the Safari not-enabled sentence alone, since the cause there is already named", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ projectPath: project, browser: "safari" }));

    expect(result.status).toBe("started");
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
    expect(result.hint).not.toContain(NO_ATTACH_DIAGNOSIS_NOTE);
  }, 15_000);
});

describe("extension_dev relays the legs this server read when the engine stamps no diagnosis", () => {
  it("answers compiled-not-attached with the failed leg and the fresh-profile relaunch, and calls the kept control port by design", async () => {
    const project = tmpProject();
    const { writeCompiledUnattachedContract } = await import("./fixtures/ready-contract");
    const says = "The browser is up (pid 1076) and the extension is loaded, but its background never connected to this session's control channel on port 49239.";

    onSpawn.replaced = [{ pid: 96457, browser: "chrome", controlPort: 49239 }];
    onSpawn.write = () => writeCompiledUnattachedContract(project, "chrome", { pid: process.pid, controlPort: 49239 });
    waitAnswer = () =>
      JSON.stringify({
        ok: false,
        status: "compiled-not-attached",
        value: {
          compiled: true,
          browserAttached: false,
          failedLeg: "executor",
          failedLegSays: says,
          legs: { controlChannel: { port: 49239 } },
          sayToPerson: `${says} ${WAY_OUT}`,
          nextStep: { kind: "relaunch", tool: "extension_dev", args: { projectPath: project, browser: "chrome", replace: true, profile: FRESH }, say: WAY_OUT },
        },
      });

    const result = JSON.parse(await dev.handler({ projectPath: project, replace: true }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.failedLeg).toBe("executor");
    expect(result.value.nextStep.args.profile).toBe(FRESH);
    expect(result.value.replacedSession).toEqual({ pid: 96457, browser: "chrome", controlPort: 49239 });
    expect(result.hint).toBe(`${says} ${WAY_OUT} ${REBUILD_NOT_REACHING_NOTE}`);
    expect(result.warnings.join(" ")).toContain("Control port 49239 is the replaced session's: the engine keeps one control port per project and browser on purpose");
  }, 15_000);
});

describe("extension_dev never answers started when the ready contract says the browser is gone", () => {
  const EXITED = "the gecko-based process exited (code unknown) before the extension loaded, nothing is running";

  const contractError = (code: string, contractCode: string, message: string): string =>
    JSON.stringify({
      ok: false,
      status: "contract-error",
      error: { code, message, contractCode },
      value: { errors: [message], browser: "chrome", budgetMs: 45_000, elapsedMs: 6_000 },
    });

  const engineGone = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

  it("answers browser-exited, not ok, with the engine's words and the stop it made", async () => {
    const project = tmpProject();

    waitAnswer = () => contractError("E_BROWSER_EXITED", "browser_exited", EXITED);

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("browser-exited");
    expect(result.error.code).toBe("E_BROWSER_EXITED");
    expect(result.error.message).toContain(EXITED);
    expect(result.value.ready).toMatchObject({ status: "contract-error", errors: [EXITED] });
    expect(result.value.sessionStopped).toBe(true);
    await vi.waitFor(() => expect(engineGone(spawned[spawned.length - 1])).toBe(true));
    expect(result.hint).toContain("replace: true");
  }, 15_000);

  it.each([
    { code: "E_BROWSER_LAUNCH_FAILED", contractCode: "browser_launch_failed", message: "firefox refused the launch flags" },
    { code: "E_COMPILE_FAILED", contractCode: "compile_failed", message: "extension.config.js threw" },
  ])("stops the dev server on $code, which its watcher does not recover from", async ({ code, contractCode, message }) => {
    const project = tmpProject();

    waitAnswer = () => contractError(code, contractCode, message);

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("contract-error");
    expect(result.error.code).toBe(code);
    expect(result.error.message).toContain(message);
    expect(result.value.sessionStopped).toBe(true);
    await vi.waitFor(() => expect(engineGone(spawned[spawned.length - 1])).toBe(true));
  }, 15_000);

  it("keeps the dev server on an error it may still recover from, says whether it runs, and gives one next step", async () => {
    const project = tmpProject();

    waitAnswer = () => contractError("E_EXTENSION_LOAD_REFUSED", "extension_load_refused", "the browser refused to load the extension");

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.status).toBe("contract-error");
    expect(result.error.message).toMatch(/The dev server is still running\.$/);
    expect(result.value.sessionStopped).toBeUndefined();
    expect(result.hint).toContain("extension_dev with replace: true");
    expect(result.hint).not.toMatch(/extension_wait|extension_stop/);
  }, 15_000);

  it("never answers ok beside a contract-error ready state, even when the wait names no error object", async () => {
    const project = tmpProject();

    waitAnswer = () => JSON.stringify({ ok: false, status: "contract-error", value: { errors: ["the profile is in use by another browser"], browser: "chrome" } });

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("contract-error");
    expect(result.error.code).toBe("E_CONTRACT_ERROR");
    expect(result.error.message).toContain("the profile is in use by another browser");
    expect(result.hint).toContain("extension_dev with replace: true");
  }, 15_000);

  it("says nothing is running when the dev server exited on an error it would otherwise keep", async () => {
    const project = tmpProject();

    waitAnswer = (async () => {
      const child = spawned[spawned.length - 1];
      const exited = new Promise((resolve) => child.once("exit", resolve));

      child.kill("SIGKILL");
      await exited;

      return contractError("E_EXTENSION_LOAD_REFUSED", "extension_load_refused", "the browser refused to load the extension");
    }) as unknown as () => string;

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.status).toBe("contract-error");
    expect(result.error.message).toMatch(/The dev server has exited, so nothing is running\.$/);
  }, 15_000);

  it("keeps the dev server on a compile_error stamped after the boot window, since a save recompiles it", async () => {
    const project = tmpProject();
    const parse = "Module parse failed: Unexpected token (3:1)";

    waitAnswer = () => contractError("E_COMPILE_ERROR", "compile_error", parse);

    const result = JSON.parse(await dev.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compile-failed");
    expect(result.error.code).toBe("E_FIRST_COMPILE");
    expect(result.error.message).toContain(parse);
    expect(result.error.message).not.toContain("nothing is running");
    expect(result.value.sessionStopped).toBeUndefined();
    expect(result.value.compileErrors).toEqual([parse]);
    expect(result.hint).toContain("the dev server is still running and will recompile");
    expect(result.hint).not.toContain("replace: true");
    expect(engineGone(spawned[spawned.length - 1])).toBe(false);
  }, 15_000);
});
