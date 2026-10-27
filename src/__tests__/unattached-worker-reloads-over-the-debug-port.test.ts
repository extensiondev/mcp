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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";
import { removeSession, removeSessionMarker } from "../lib/process-manager";
import { writeCompiledUnattachedContract } from "./fixtures/ready-contract";
import { HANG, onlyFakeChromeFetch, startFakeChrome, type FakeChrome, type FakeCommand } from "./fixtures/fake-chrome";

import type { ReadyContract } from "../lib/types";

const { handler: wait } = await import("../tools/wait");
const { recoverUnattachedOnce, reloadUnattachedWorker, RECOVER_AFTER_MS } = await import("../lib/executor-recovery");
const { REBUILD_NOT_REACHING_NOTE } = await import("../lib/compiled-not-attached");

const EXTENSION_ID = "gilebldjbffpkjnbciipghplepdmpjde";
const WORKER = { id: "SW1", type: "service_worker", url: `chrome-extension://${EXTENSION_ID}/background/service_worker.js` };

let dir: string;
let chrome: FakeChrome | null;

function contract(): ReadyContract {
  return JSON.parse(fs.readFileSync(readyContractPath(dir, "chrome"), "utf8")) as ReadyContract;
}

function patch(extra: Record<string, unknown>): void {
  fs.writeFileSync(readyContractPath(dir, "chrome"), JSON.stringify({ ...contract(), ...extra }));
}

function reloadsRun(): FakeCommand[] {
  return (chrome?.commands ?? []).filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("chrome.runtime.reload()"));
}

async function browserWhoseReload(attaches: boolean, targets = [WORKER]): Promise<FakeChrome> {
  chrome = await startFakeChrome(targets, (command) => {
    if (command.method !== "Runtime.evaluate") return undefined;

    if (attaches) {
      const at = new Date().toISOString();
      setTimeout(() => patch({ executorAttachedAt: at, runtime: "attached", ts: at }), 100);
    }

    return { result: { type: "boolean", value: true } };
  });

  vi.stubGlobal("fetch", onlyFakeChromeFetch(() => chrome?.port ?? -1));

  return chrome;
}

function stamp(port: number, overrides: Record<string, unknown> = {}): void {
  writeCompiledUnattachedContract(dir, "chrome", { extensionId: EXTENSION_ID, cdpPort: port, browserPid: process.pid, ...overrides });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-unattached-reload-"));
  chrome = null;
  vi.stubGlobal("fetch", () => {
    throw new Error("these specs reach only their fake browser");
  });
});

afterEach(async () => {
  await chrome?.close();
  removeSession(dir, "chrome");
  removeSessionMarker(dir, "chrome");
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("a Chromium dev session whose background never connected is reloaded over the debug port instead of left silent", () => {
  it("extension_wait reloads the extension once the background stays unconnected, and answers ready with what it did", async () => {
    const browser = await browserWhoseReload(true);
    stamp(browser.port, { runId: "run-wait-recovers" });

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: RECOVER_AFTER_MS + 9_000 }));

    expect(result.status).toBe("ready");
    expect(result.value.browserAttached).toBe(true);
    expect(result.value.executorRecovery).toMatchObject({ outcome: "attached" });
    expect(result.warnings.join(" ")).toContain("this server reloaded the extension over the debug port");
    expect(reloadsRun()).toHaveLength(1);
    expect(reloadsRun()[0]!.sessionId).toBe("S-SW1");
  }, 40_000);

  it("leaves the session alone before the background has been unconnected for the recovery delay, and off Chromium", async () => {
    const browser = await browserWhoseReload(true);
    stamp(browser.port, { runId: "run-too-early" });

    expect(await recoverUnattachedOnce({ projectPath: dir, browser: "chrome", contract: contract(), unattachedForMs: RECOVER_AFTER_MS - 1, remainingMs: 30_000 })).toBeNull();
    expect(await recoverUnattachedOnce({ projectPath: dir, browser: "firefox", contract: contract(), unattachedForMs: RECOVER_AFTER_MS + 1, remainingMs: 30_000 })).toBeNull();
    expect(reloadsRun()).toHaveLength(0);
  });

  it("reloads one session only once, so a background that still does not connect is not reloaded in a loop", async () => {
    const browser = await browserWhoseReload(false);
    stamp(browser.port, { runId: "run-once" });
    const input = { projectPath: dir, browser: "chrome", contract: contract(), unattachedForMs: RECOVER_AFTER_MS + 1, remainingMs: 30_000 };

    const first = await recoverUnattachedOnce(input);

    expect(first).toMatchObject({ outcome: "not-attached" });
    expect(await recoverUnattachedOnce(input)).toBeNull();
    expect(reloadsRun()).toHaveLength(1);
  }, 20_000);

  it("says why when the browser lists no background to reload", async () => {
    const browser = await browserWhoseReload(true, []);
    stamp(browser.port);

    const result = await reloadUnattachedWorker({ projectPath: dir, browser: "chrome", contract: contract(), watchMs: 200 });

    expect(result.outcome).toBe("unreachable");
    expect(result.say).toContain("could not reload the extension over the debug port");
  });

  it("extension_wait for rebuild reloads over the debug port when the background is not connected, and says the edit reached the browser", async () => {
    const browser = await browserWhoseReload(true);
    stamp(browser.port, { compiledAt: "2026-10-27T17:00:00.000Z" });
    setTimeout(() => patch({ compiledAt: new Date().toISOString(), ts: new Date().toISOString() }), 300);

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 15_000 }));

    expect(result.status).toBe("rebuilt");
    expect(result.value.reload).toMatchObject({ outcome: "reattached", reloadKind: "debug-port" });
    expect(result.hint).toContain("could not apply its reload");
    expect(reloadsRun()).toHaveLength(1);
  }, 20_000);

  it("extension_wait for rebuild answers not-reached when the reload over the debug port cannot bring the background back", async () => {
    const browser = await browserWhoseReload(false);
    stamp(browser.port, { compiledAt: "2026-10-27T17:00:00.000Z" });
    setTimeout(() => patch({ compiledAt: new Date().toISOString(), ts: new Date().toISOString() }), 300);

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 15_000 }));

    expect(result.status).toBe("rebuilt");
    expect(result.value.reload.outcome).toBe("not-reached");
    expect(result.hint).toContain("still runs the build it loaded before");
  }, 20_000);

  it("the compiled-not-attached answer says a rebuild does not reach the browser until the background connects", async () => {
    chrome = await startFakeChrome([], () => HANG);
    vi.stubGlobal("fetch", onlyFakeChromeFetch(() => chrome?.port ?? -1));
    stamp(chrome.port);

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1_500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.rebuildsReachBrowser).toBe(false);
    expect(result.error.message).toContain(REBUILD_NOT_REACHING_NOTE);
  });
});
