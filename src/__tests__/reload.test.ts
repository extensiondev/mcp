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

import { reloadFrame, stampExecutorAttached, stampExecutorDetached } from "./fixtures/engine-answers";
import { writeModernContract } from "./fixtures/ready-contract";

import type * as ActModule from "../lib/act";

const act = vi.hoisted(() => ({
  calls: [] as Array<{ cli: string[]; projectPath: string; timeout: number | undefined; tool: string | undefined }>,
  reply: "" as string,
  onCall: null as null | (() => void),
}));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[], projectPath: string, timeout?: number, tool?: string) => {
      act.calls.push({ cli, projectPath, timeout, tool });
      act.onCall?.();

      return act.reply;
    },
  };
});

const session = vi.hoisted(() => ({ browser: "chrome", asked: [] as Array<string | undefined> }));
vi.mock("../lib/session-browser", () => ({
  resolveSessionBrowser: (_projectPath: string, explicit: string | undefined) => {
    session.asked.push(explicit);

    return { browser: explicit ?? session.browser, source: explicit ? "explicit" : "session" };
  },
}));

const reload = await import("../tools/reload");

const ATTACHED_AT = "2026-10-07T12:00:00.000Z";
let projectPath = "";
let contractFile = "";

beforeEach(() => {
  act.calls.length = 0;
  act.onCall = null;
  act.reply = JSON.stringify(reloadFrame());
  session.browser = "chrome";
  session.asked.length = 0;
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reload-"));
  contractFile = writeModernContract(projectPath, "zen", {
    runtime: "attached",
    executorAttachedAt: ATTACHED_AT,
    ts: ATTACHED_AT,
  });
});

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true });
});

const parsed = (out: string) => JSON.parse(out) as { ok: boolean; status: string; value: Record<string, unknown>; warnings: string[]; hint?: string };

describe("extension_reload hands the reload verb to the engine as it was asked", () => {
  it("is registered as extension_reload and names the control channel it needs", () => {
    expect(reload.schema.name).toBe("extension_reload");
    expect(reload.schema.description).toContain("allowControl");
    expect(reload.schema.inputSchema.required).toEqual(["projectPath"]);
    expect((reload.schema.inputSchema.properties.context as { default: string }).default).toBe("background");
  });

  it("reloads the background by default, on the session's own browser, naming extension_reload as the owner", async () => {
    session.browser = "zen";

    act.onCall = () => {
      setTimeout(() => stampExecutorDetached(contractFile), 10);
      setTimeout(() => stampExecutorAttached(contractFile), 40);
    };

    await reload.handler({ projectPath });

    expect(act.calls).toHaveLength(1);
    expect(act.calls[0].cli).toEqual(["reload", projectPath, "--browser", "zen"]);
    expect(act.calls[0].projectPath).toBe(projectPath);
    expect(act.calls[0].timeout).toBeUndefined();
    expect(act.calls[0].tool).toBe("extension_reload");
    expect(session.asked).toEqual([undefined]);
  });

  it("passes context, tab, an explicit browser and the timeout through commonFlags, and hands a tab reload back as it came", async () => {
    act.reply = JSON.stringify(reloadFrame(7));

    const out = await reload.handler({
      projectPath,
      context: "content",
      tab: 7,
      browser: "edge",
      timeout: 1500,
    });

    expect(out).toBe(act.reply);
    expect(act.calls[0].cli).toEqual([
      "reload",
      projectPath,
      "--context",
      "content",
      "--tab",
      "7",
      "--browser",
      "edge",
      "--timeout",
      "1500",
    ]);

    expect(act.calls[0].timeout).toBe(1500);
    expect(session.asked).toEqual(["edge"]);
  });

  it("returns a refusal from the engine as it came, without rewording it", async () => {
    act.reply = JSON.stringify({
      ok: false,
      command: "extension_reload",
      status: "failed",
      value: null,
      error: { code: "E_SESSION_NOT_FOUND", name: "CliError", message: "No active control channel found for chrome." },
      warnings: [],
    });

    const out = await reload.handler({ projectPath, context: "page", tab: 2 });

    expect(out).toBe(act.reply);
    expect(act.calls[0].cli).toEqual(["reload", projectPath, "--context", "page", "--tab", "2", "--browser", "chrome"]);
  });
});

/* @invariant The engine answers reloading 50 ms BEFORE chrome.runtime.reload()
   runs, so a background reload is only done once ready.json shows the new
   executor attached again. These cells drive the contract the way the engine's
   writer does (stampExecutorDetached, then stampExecutorAttached) and fail with
   the watch removed from reload.ts: the first because value.reattached is
   absent, the second and third because the warnings are. */
describe("a background reload waits for the contract to show the executor back", () => {
  it("answers once ready.json flips detached then attached, and says what it read", async () => {
    session.browser = "zen";

    act.onCall = () => {
      setTimeout(() => stampExecutorDetached(contractFile, "2026-10-07T12:00:01.000Z"), 10);
      setTimeout(() => stampExecutorAttached(contractFile, "2026-10-07T12:00:01.300Z"), 60);
    };

    const out = parsed(await reload.handler({ projectPath }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("ok");
    expect(out.value.reloading).toBe(true);
    expect(out.value.reattached).toBe(true);
    expect(out.value.reattachWatch).toBe("reattached");
    expect(out.value.detachedAt).toBe("2026-10-07T12:00:01.000Z");
    expect(out.value.attachedTs).toBe("2026-10-07T12:00:01.300Z");
    expect(out.value.reattachedMs).toBeGreaterThanOrEqual(40);
    expect(out.value.reattachedMs).toBeLessThan(5_000);
    expect(out.hint).toContain("detached at 2026-10-07T12:00:01.000Z and attached again");
    expect(out.hint).toContain("ms after the engine answered reloading");
    expect(out.warnings).toEqual([]);
  });

  it("proves a reattach the poll was too slow to see detached by the contract's ts moving", async () => {
    session.browser = "zen";

    act.onCall = () => {
      stampExecutorDetached(contractFile, "2026-10-07T12:00:01.000Z");
      stampExecutorAttached(contractFile, "2026-10-07T12:00:01.010Z");
    };

    const out = parsed(await reload.handler({ projectPath }));

    expect(out.value.reattached).toBe(true);
    expect(out.value.detachedAt).toBeUndefined();
    expect(out.value.attachedTs).toBe("2026-10-07T12:00:01.010Z");
    expect(out.hint).toMatch(/^ready.json stamped the executor attached again \d+ ms after/);
  });

  it("answers status reloading with the detach stamp when the new background has not come back in the budget", async () => {
    session.browser = "zen";

    act.onCall = () => {
      setTimeout(() => stampExecutorDetached(contractFile, "2026-10-07T12:00:02.000Z"), 10);
    };

    const out = parsed(await reload.handler({ projectPath, timeout: 150 }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("reloading");
    expect(out.value.reattached).toBe(false);
    expect(out.value.reattachWatch).toBe("still-detached");
    expect(out.value.detachedAt).toBe("2026-10-07T12:00:02.000Z");
    expect(out.value.reattachedMs).toBeGreaterThanOrEqual(150);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("stamped the executor detached at 2026-10-07T12:00:02.000Z, but it had not attached again");
    expect(out.warnings[0]).toContain("extension_assert answers inconclusive");
    expect(act.calls[0].cli).toContain("--timeout");
  });

  it("says the reload was not observed when ready.json never changes", async () => {
    const out = parsed(await reload.handler({ projectPath, browser: "zen", timeout: 100 }));

    expect(out.status).toBe("ok");
    expect(out.value.reattached).toBeNull();
    expect(out.value.reattachWatch).toBe("unobserved");
    expect(out.warnings[0]).toContain('ready.json did not change in the');
    expect(out.warnings[0]).toContain('runtime still "attached", ts unchanged');
    expect(out.warnings[0]).toContain("The old background may still be running");
  });

  it("says the reattach was not watched when there is no contract to read", async () => {
    fs.rmSync(contractFile);

    const out = parsed(await reload.handler({ projectPath, browser: "zen", timeout: 100 }));

    expect(out.value.reattached).toBeNull();
    expect(out.value.reattachWatch).toBe("unreadable");
    expect(out.warnings[0]).toContain("could not read ready.json for zen before the call");
  });

  it("caps the watch at five seconds whatever timeout the call carries", async () => {
    session.browser = "zen";

    act.onCall = () => {
      setTimeout(() => stampExecutorDetached(contractFile), 10);
      setTimeout(() => stampExecutorAttached(contractFile), 30);
    };

    const out = parsed(await reload.handler({ projectPath, timeout: 60_000 }));

    expect(out.value.reattached).toBe(true);
    expect(out.value.reattachedMs).toBeLessThan(5_000);
  });
});
