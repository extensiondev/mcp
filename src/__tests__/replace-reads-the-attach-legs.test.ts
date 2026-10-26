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
import { spawn, spawnSync } from "node:child_process";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as GuestModule from "../lib/guest-load-oracle";

const guest = vi.hoisted(() => ({ checked: true, loaded: true }));

vi.mock("../lib/guest-load-oracle", async (importOriginal) => {
  const actual = await importOriginal<typeof GuestModule>();

  return {
    ...actual,
    verifyGuestLoaded: async () => ({
      checked: guest.checked,
      loaded: guest.loaded,
      guestTargets: [],
      guestIds: guest.loaded ? ["gilebldjbffpkjnbciipghplepdmpjde"] : [],
      reason: guest.checked ? "read the target list" : "No CDP port in the session's ready contract",
    }),
  };
});

const { handler: wait } = await import("../tools/wait");
const { guardSameBrowserSession } = await import("../lib/same-browser-session");
const { CONTROL_PORT_KEPT_NOTE } = await import("../lib/compiled-not-attached");
const { registerSession, removeSession, removeSessionMarker } = await import("../lib/process-manager");
const { writeCompiledUnattachedContract } = await import("./fixtures/ready-contract");

const PORT = 49239;
const children: ChildProcess[] = [];
let dir: string;
let profile: string;

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

function stamp(overrides: Record<string, unknown> = {}): void {
  writeCompiledUnattachedContract(dir, "chrome", {
    pid: process.pid,
    browserPid: process.pid,
    profilePath: profile,
    controlPort: PORT,
    cdpPort: 9222,
    ...overrides,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-replace-legs-"));
  profile = path.join(dir, "dist", "extension-profile-chrome");
  guest.checked = true;
  guest.loaded = true;
  vi.stubGlobal("fetch", () => {
    throw new Error("attach-leg specs never reach the network");
  });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  removeSession(dir, "chrome");
  removeSessionMarker(dir, "chrome");
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("a Chrome session that never attaches names the leg that failed, read by this server when the engine stamps no diagnosis", () => {
  it("on a reused profile: browser up, extension loaded, executor never dialed, and the way out is a fresh profile, not another restart", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev", profileReused: true });
    stamp();

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.value.failedLeg).toBe("executor");
    expect(result.value.legs).toMatchObject({
      browser: { pid: process.pid, alive: true },
      extension: { loaded: true, guestIds: ["gilebldjbffpkjnbciipghplepdmpjde"] },
      controlChannel: { port: PORT, note: CONTROL_PORT_KEPT_NOTE },
      executor: { attached: false },
      profile: { path: profile, reused: true },
    });

    expect(result.value.failedLegSays).toContain(`never connected to this session's control channel on port ${PORT}`);
    expect(result.value.failedLegSays).toContain("a plain restart does not help");
    expect(result.value.nextStep).toMatchObject({ kind: "relaunch", tool: "extension_dev", args: { projectPath: dir, browser: "chrome", replace: true } });
    expect(result.value.nextStep.args.profile.startsWith(`${profile}-fresh-`)).toBe(true);
    expect(result.value.nextStep.args.profile.slice(profile.length)).toMatch(/^-fresh-\d{12}$/);
    expect(result.hint).not.toContain("a restart reliably reattaches");
    expect(result.error.message).toContain("Read here instead:");
  }, 10_000);

  it("says the browser leg failed when the browser pid the contract names is gone", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev", profileReused: true });
    const gone = deadPid();

    stamp({ browserPid: gone });

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.value.failedLeg).toBe("browser");
    expect(result.value.failedLegSays).toContain(`(pid ${gone}) is gone`);
    expect(result.value.nextStep).toBeUndefined();
  }, 10_000);

  it("says the extension never loaded when the target list lacks it", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev", profileReused: true });
    guest.loaded = false;
    stamp();

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.value.failedLeg).toBe("extension-load");
    expect(result.value.nextStep.kind).toBe("relaunch");
  }, 10_000);

  it("on a fresh profile names the executor leg but keeps the wait-again advice, since no stale copy is in play", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev", profileReused: false });
    stamp();

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.value.failedLeg).toBe("executor");
    expect(result.value.failedLegSays).not.toContain("had been run before");
    expect(result.value.nextStep).toBeUndefined();
    expect(result.hint).toContain("call extension_wait again");
  }, 10_000);

  it("reads no legs when the browser list cannot be read, and keeps the plain answer", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    guest.checked = false;
    stamp();

    const result = JSON.parse(await wait({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.value.failedLeg).toBeUndefined();
    expect(result.error.message).not.toContain("Read here instead:");
  }, 10_000);
});

describe("replace: true stops the old session first and remembers the control port it held", () => {
  it("records the replaced session's control port and ends its process before the new one starts", async () => {
    const old = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    children.push(old);
    registerSession({ pid: old.pid!, browser: "chrome", projectPath: dir, command: "dev" });
    stamp({ pid: old.pid, browserPid: null });

    const guard = await guardSameBrowserSession({
      tool: "extension_dev",
      projectPath: dir,
      browser: "chrome",
      replace: true,
      hazard: "",
      replacing: "the new one",
    });

    expect("replaced" in guard && guard.replaced).toEqual([{ pid: old.pid, browser: "chrome", controlPort: PORT }]);
    await vi.waitFor(() => expect(old.exitCode !== null || old.signalCode !== null).toBe(true));
  }, 10_000);
});
