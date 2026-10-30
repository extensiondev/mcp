import { afterEach, describe, expect, it } from "vitest";

import { envelope } from "../lib/envelope";
import { adoptLocalState, createLocalState, isLocalState, localState } from "../lib/local-state";
import { rememberExtensionTarget, rememberedExtensionTargetUrl } from "../lib/extension-reload";
import { findSessionInfo, listSessions, registerSession, removeSession, sessionSinceMs } from "../lib/process-manager";
import { adoptHandover, carriesLocalState, handoverState, type RebuiltBuild } from "../lib/server-reload";
import { createServerStamp, staleLocalWarning } from "../lib/server-stamp";
import { markStaleLocal, noLocalCarryReason, predatedChecks, predatesCheckEnvelope, type HeldLocal } from "../lib/stale-local";

import { version } from "../../package.json";

const PROJECT = "/tmp/extdev-local-state-probe";

describe("the session registry belongs to the process and crosses a reload by reference", () => {
  const original = localState();

  afterEach(() => {
    adoptLocalState(original);
    removeSession(PROJECT, "chrome");
  });

  it("a build that adopts the handover reads and writes the same registry the previous generation filled", () => {
    const generationOne = createLocalState();
    adoptLocalState(generationOne);
    registerSession({ pid: 515151, browser: "chrome", projectPath: PROJECT, command: "dev" });
    rememberExtensionTarget("T1", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html");

    const handed = handoverState({ features: ["local"], noShip: false });

    expect(handed.local).toBe(generationOne);

    const generationTwo = createLocalState();
    adoptLocalState(generationTwo);

    expect(listSessions()).toEqual([]);
    expect(rememberedExtensionTargetUrl("T1")).toBeNull();

    adoptHandover(handed);

    expect(localState()).toBe(generationOne);
    expect(listSessions().map((session) => session.pid)).toEqual([515151]);
    expect(findSessionInfo(PROJECT, "chrome")?.pid).toBe(515151);
    expect(sessionSinceMs(PROJECT, "chrome")).toEqual(expect.any(Number));
    expect(rememberedExtensionTargetUrl("T1")).toContain("popup.html");

    removeSession(PROJECT, "chrome", 515151);

    expect(generationOne.sessions.size).toBe(0);
  });

  it("refuses a handover without a well-formed local state and keeps its own", () => {
    const own = createLocalState();
    adoptLocalState(own);

    expect(adoptLocalState(undefined)).toBe(false);
    expect(adoptLocalState({ sessions: new Map() })).toBe(false);
    expect(localState()).toBe(own);
    expect(isLocalState(createLocalState())).toBe(true);
    expect(isLocalState({ sessions: [], registrations: new Map(), extensionTargets: new Map(), recoveredSessions: new Set() })).toBe(false);
  });

  it("tells a build that carries the local state from one that drops it by the handover it echoes back", () => {
    const state = handoverState({ features: ["local"], noShip: false });
    const carrying = { handoverState: () => state } as unknown as RebuiltBuild;
    const dropping = { handoverState: () => ({ options: state.options, keptLogins: state.keptLogins }) } as unknown as RebuiltBuild;
    const throwing = { handoverState: () => { throw new Error("no"); } } as unknown as RebuiltBuild;

    expect(carriesLocalState(carrying, state)).toBe(true);
    expect(carriesLocalState(dropping, state)).toBe(false);
    expect(carriesLocalState(throwing, state)).toBe(false);
    expect(carriesLocalState(carrying, { options: state.options, keptLogins: [] })).toBe(false);
  });
});

describe("every answer from held local code says so, and the verdict it produces reads stale", () => {
  const stamp = { ...createServerStamp("/nowhere/module.js").stamp(), builtAt: "2026-10-30T16:00:00.000Z" };
  const held: HeldLocal = { rebuilt: "2026-10-30T16:40:05.170Z", reason: noLocalCarryReason("2026-10-30T16:40:05.170Z"), version: `${version}+7c7b6ea`, assertChecks: ["background-worker-booted", "page-world-clean", "page-world-sealed"] };
  const newerBuild = { version: `${version}+7c7b6ea`, builtAt: "2026-10-30T16:40:05.170Z" };

  it("marks the verdict's producer and value.server with the newer build, and warns, on every call", () => {
    const verdict = envelope({
      ok: true,
      command: "extension_assert",
      status: "pass",
      value: { producer: { name: "@extension.dev/mcp", version: `${version}+a4ffd3d` }, outcome: "pass", passed: true },
      hint: "1/1 passed.",
    });
    const once = JSON.parse(markStaleLocal(verdict, stamp, held));
    const twice = JSON.parse(markStaleLocal(verdict, stamp, held));

    expect(once.value.producer).toEqual({ name: "@extension.dev/mcp", version: `${version}+a4ffd3d`, stale: true, newerBuild });
    expect(once.value.server).toEqual({ ...stamp, stale: true, newerBuild });
    expect(once.value.outcome).toBe("pass");
    expect(once.hint).toBe("1/1 passed.");
    expect(once.warnings).toEqual([staleLocalWarning("2026-10-30T16:00:00.000Z", "2026-10-30T16:40:05.170Z", held.reason)]);
    expect(twice.warnings).toEqual(once.warnings);
  });

  it("marks an answer without a producer, and a null value, and leaves plain text alone", () => {
    const plain = JSON.parse(markStaleLocal(envelope({ ok: true, command: "extension_wait", status: "ready", value: { compiled: true } }), stamp, held));

    expect(plain.value).toEqual({ compiled: true, server: { ...stamp, stale: true, newerBuild } });
    expect(plain.value.producer).toBeUndefined();

    const empty = JSON.parse(markStaleLocal(envelope({ ok: false, command: "extension_stop", status: "no-session", error: { code: "E_NO_SESSION", message: "none" } }), stamp, held));

    expect(empty.value).toEqual({ server: { ...stamp, stale: true, newerBuild } });
    expect(empty.error.code).toBe("E_NO_SESSION");
    expect(markStaleLocal("not json", stamp, held)).toBe("not json");
  });

  it("names the checks only the build on disk declares, and never one this build knows or neither knows", () => {
    const args = { projectPath: PROJECT, expect: [{ assert: "page-world-sealed" }, { assert: "background-worker-booted" }, { assert: "no-such-check" }, { assert: "page-world-sealed" }, "junk", { assert: 7 }] };

    expect(predatedChecks("extension_assert", args, held)).toEqual(["page-world-sealed"]);
    expect(predatedChecks("extension_wait", args, held)).toEqual([]);
    expect(predatedChecks("extension_assert", args, { ...held, assertChecks: null })).toEqual([]);
    expect(predatedChecks("extension_assert", { expect: "page-world-sealed" }, held)).toEqual([]);

    const out = JSON.parse(predatesCheckEnvelope("extension_assert", ["page-world-sealed", "page-world-quiet"], stamp, held));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("server-stale");
    expect(out.error.code).toBe("E_SERVER_STALE");
    expect(out.error.message).toBe(
      `This server predates the checks page-world-sealed, page-world-quiet: it was built at 2026-10-30T16:00:00.000Z, the build on disk at 2026-10-30T16:40:05.170Z declares them, and ${held.reason}; run /mcp and pick extension-dev, then assert again.`,
    );

    expect(out.value).toEqual({ predates: ["page-world-sealed", "page-world-quiet"], server: { ...stamp, stale: true, newerBuild }, reloadError: held.reason });
  });
});
