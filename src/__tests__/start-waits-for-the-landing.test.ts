// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as BootVerdictModule from "../lib/boot-verdict";
import type * as CdpModule from "../lib/cdp";
import type * as ExecModule from "../lib/exec";
import type * as WaitModule from "../tools/wait";

const GUEST_ID = "abcdefghijklmnopabcdefghijklmnop";
const ENGINE_PID = 4242;

const live = {
  project: "",
  targets: [] as Array<{ id: string; type: string; url: string }>,
  waitCalls: [] as Array<Record<string, unknown>>,
  waitAnswer: null as null | (() => string),
  landContract: null as null | (() => void),
};

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => ({
      child: Object.assign(new EventEmitter(), { pid: ENGINE_PID, kill: () => true }),
      logPath: path.join(live.project, "session.log"),
      readOutput: () => "",
    }),
  };
});

vi.mock("../lib/boot-verdict", async (importOriginal) => {
  const actual = await importOriginal<typeof BootVerdictModule>();

  return {
    ...actual,
    pollBootVerdict: async () => {
      live.landContract?.();

      return { verdict: { kind: "alive" }, evidenceTail: "", warnings: [] };
    },
  };
});

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpModule>();

  return {
    ...actual,
    CDPClient: Object.assign(class {}, {
      discoverTargets: async () => live.targets,
      discoverBrowserWsUrl: async () => "ws://127.0.0.1:9222/devtools/browser/fake",
    }),
  };
});

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async (args: Record<string, unknown>) => {
      live.waitCalls.push(args);

      return live.waitAnswer ? live.waitAnswer() : actual.handler(args as Parameters<typeof actual.handler>[0]);
    },
  };
});

const { handler, schema } = await import("../tools/start");
const { removeSession, removeSessionMarker } = await import("../lib/process-manager");
const { readyContractPath } = await import("../lib/session-paths");
const { readyContract } = await import("./fixtures/engine-answers");

function stampReady(overrides: Record<string, unknown> = {}): void {
  const file = readyContractPath(live.project, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      readyContract("start", "chrome", {
        pid: process.pid,
        browserPid: process.pid,
        launcherPid: process.pid,
        distPath: path.join(live.project, "dist", "chrome"),
        compiledAt: new Date().toISOString(),
        extensionId: GUEST_ID,
        cdpPort: 9222,
        toolchainVersion: "4.1.36",
        ...overrides,
      }),
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  live.project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-waits-"));
  live.targets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` }];
  live.waitCalls = [];
  live.waitAnswer = null;
  live.landContract = () => stampReady();
});

afterEach(() => {
  vi.useRealTimers();
  removeSession(live.project, "chrome");
  removeSessionMarker(live.project, "chrome");
  fs.rmSync(live.project, { recursive: true, force: true });
});

describe("extension_start waits for the build and the browser the way extension_dev does", () => {
  it("declares wait on by default", () => {
    const wait = schema.inputSchema.properties.wait;

    expect(wait.default).toBe(true);
    expect(wait.description).toMatch(/extension_wait/);
    expect(schema.description).toMatch(/no extension_wait is needed/);
  });

  it("answers build-ready with the session, the extension id and cdpPort once the contract lands, and says no extension_wait is needed", async () => {
    const result = JSON.parse(await handler({ projectPath: live.project, allowControl: true }));

    expect(live.waitCalls).toEqual([{ projectPath: live.project, browser: "chrome", timeoutMs: 45_000 }]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("build-ready");
    expect(result.value).toMatchObject({
      pid: ENGINE_PID,
      browser: "chrome",
      projectPath: live.project,
      verb: "start",
      allowControl: true,
      compiled: true,
      browserAttached: true,
      extensionId: GUEST_ID,
      cdpPort: 9222,
      extensionLoaded: true,
      waited: { status: "landed", budgetMs: 45_000, elapsedMs: 0 },
    });

    expect(result.hint).toMatch(/^The build landed and chrome loaded the extension within 0 ms of the spawn, so no extension_wait is needed\./);
    expect(result.hint).toMatch(/This is an extension_start session/);
    expect(result.hint).toMatch(/extension_stop/);
  });

  it("keeps the started answer when the wait runs out, with the deadline and the extension_wait call to keep waiting", async () => {
    live.landContract = null;
    live.waitAnswer = () =>
      JSON.stringify({
        ok: false,
        command: "extension_wait",
        status: "timeout",
        error: { code: "E_WAIT_TIMEOUT", message: "Not ready after 45000ms this call: no ready contract was observed." },
        value: { compiled: false, browserAttached: false, budgetMs: 45_000, elapsedMs: 45_000 },
      });

    const result = JSON.parse(await handler({ projectPath: live.project }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.value.pid).toBe(ENGINE_PID);
    expect(result.value.waited).toEqual({ status: "timeout", budgetMs: 45_000, elapsedMs: 45_000 });
    expect(result.hint).toMatch(/the build had not landed 45000 ms later \(Not ready after 45000ms this call/);
    expect(result.hint).toContain(`extension_wait {projectPath: ${JSON.stringify(live.project)}, browser: "chrome"}`);
    expect(result.hint).toMatch(/pass wait: false to skip this wait/);
  });

  it("answers the wait's own failure, with the session beside it, when the build fails after the boot check", async () => {
    live.landContract = null;
    live.waitAnswer = () =>
      JSON.stringify({
        ok: false,
        command: "extension_wait",
        status: "contract-error",
        error: { code: "E_COMPILE_FAILED", message: "The dev server stamped its ready contract with an error." },
        value: { errors: ["src/background.ts: Unexpected token"], browser: "chrome", budgetMs: 45_000, elapsedMs: 3_000 },
        hint: "Fix the errors in value.errors and save.",
      });

    const result = JSON.parse(await handler({ projectPath: live.project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("contract-error");
    expect(result.error.code).toBe("E_COMPILE_FAILED");
    expect(result.value).toMatchObject({ pid: ENGINE_PID, verb: "start", errors: ["src/background.ts: Unexpected token"], waited: { status: "failed" } });
    expect(result.hint).toBe("Fix the errors in value.errors and save.");
  });

  it("answers started right after the boot check with wait: false, and never calls the wait", async () => {
    const result = JSON.parse(await handler({ projectPath: live.project, wait: false }));

    expect(live.waitCalls).toEqual([]);
    expect(result.status).toBe("started");
    expect(result.value.waited).toBeUndefined();
    expect(result.hint).toMatch(/^The engine's start process was alive 5 s after spawn and/);
  });

  it("never waits for a browser on a noBrowser start", async () => {
    const result = JSON.parse(await handler({ projectPath: live.project, noBrowser: true }));

    expect(live.waitCalls).toEqual([]);
    expect(result.status).toBe("started");
  });
});
