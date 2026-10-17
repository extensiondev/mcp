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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../tools/wait";
import { readyContractPath } from "../lib/session-paths";
import { attachedDevContract, errorContract } from "./fixtures/engine-answers";

const EARLIER = "2026-10-05T12:00:00.000Z";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-modes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stamp(browser: string, contract: Record<string, unknown>): void {
  const file = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contract));
}

function later(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe("extension_wait for: rebuild", () => {
  it.each(["chrome", "firefox", "safari"])(
    "answers the new compile stamp and the background reconnecting on %s",
    async (browser) => {
      stamp(browser, attachedDevContract(browser, { compiledAt: EARLIER, ts: EARLIER }));
      const waiting = handler({ projectPath: dir, browser, for: "rebuild", timeoutMs: 4000 });

      await new Promise((resolve) => setTimeout(resolve, 300));
      const compiledAt = later(0);
      stamp(browser, attachedDevContract(browser, { compiledAt, ts: compiledAt, runtime: "detached", executorDetachedAt: compiledAt }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      stamp(browser, attachedDevContract(browser, { compiledAt, ts: later(50) }));

      const result = JSON.parse(await waiting);

      expect(result.ok).toBe(true);
      expect(result.status).toBe("rebuilt");
      expect(result.value.compiledAt).toBe(compiledAt);
      expect(result.value.previousCompiledAt).toBe(EARLIER);
      expect(result.value.errors).toEqual([]);
      expect(result.value.reload.outcome).toBe("reattached");
    },
  );

  it.each([
    { browser: "chrome", kind: "content", label: "content script content/scripts.js" },
    { browser: "firefox", kind: "page", label: "options page" },
    { browser: "safari", kind: "safari-resync", label: "Safari app re-sync" },
    { browser: "chrome", kind: "background", label: "background" },
  ])("waits past the compile for the $kind reload the engine stamps on $browser", async ({ browser, kind, label }) => {
    const before = { reloadedAt: EARLIER, reloadKind: "full", reloadLabel: "earlier" };
    stamp(browser, attachedDevContract(browser, { compiledAt: EARLIER, ts: EARLIER, ...before }));
    const waiting = handler({ projectPath: dir, browser, for: "rebuild", timeoutMs: 6000 });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const compiledAt = later(0);
    stamp(browser, attachedDevContract(browser, { compiledAt, ts: compiledAt, ...before }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const reloadedAt = later(0);
    stamp(browser, attachedDevContract(browser, { compiledAt, ts: reloadedAt, reloadedAt, reloadKind: kind, reloadLabel: label }));

    const result = JSON.parse(await waiting);

    expect(result.status).toBe("rebuilt");
    expect(result.value.compiledAt).toBe(compiledAt);
    expect(result.value.reload).toMatchObject({ outcome: "reloaded", reloadedAt, reloadKind: kind, reloadLabel: label });
    expect(result.hint).not.toMatch(/leaves no stamp/);
  });

  it("keeps the not-stamped answer for an engine that writes no reloadedAt", async () => {
    stamp("chrome", attachedDevContract("chrome", { compiledAt: EARLIER, ts: EARLIER }));
    const waiting = handler({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 6000 });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const compiledAt = later(0);
    stamp("chrome", attachedDevContract("chrome", { compiledAt, ts: compiledAt }));

    const result = JSON.parse(await waiting);

    expect(result.status).toBe("rebuilt");
    expect(result.value.reload.outcome).toBe("not-stamped");
  }, 15_000);

  it("counts a compile that landed before the call when since predates it", async () => {
    const compiledAt = later(-2000);
    stamp("chrome", attachedDevContract("chrome", { compiledAt, ts: later(-1000) }));

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", for: "rebuild", since: EARLIER, timeoutMs: 2000 }),
    );

    expect(result.status).toBe("rebuilt");
    expect(result.value.compiledAt).toBe(compiledAt);
  });

  it("answers the compile errors of a rebuild that failed", async () => {
    stamp("chrome", attachedDevContract("chrome", { compiledAt: EARLIER, ts: EARLIER }));
    const waiting = handler({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 4000 });

    await new Promise((resolve) => setTimeout(resolve, 300));
    stamp("chrome", errorContract("chrome", "compile_error", { ts: later(0) }));

    const result = JSON.parse(await waiting);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compile-error");
    expect(result.error.code).toBe("E_COMPILE");
    expect(result.value.errors).toEqual(["Module not found: ./missing"]);
  });

  it("times out naming the stamp it waited past, so the next call can pass it as since", async () => {
    stamp("chrome", attachedDevContract("chrome", { compiledAt: EARLIER, ts: EARLIER }));

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 1200 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.error.code).toBe("E_WAIT_TIMEOUT");
    expect(result.value.since).toBe(EARLIER);
    expect(result.hint).toContain(`since: "${EARLIER}"`);
  });
});

describe("extension_wait only reads", () => {
  it("refuses until and names extension_eval, so a condition never runs code here", async () => {
    stamp("chrome", attachedDevContract("chrome"));

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", until: { expression: "1" }, timeoutMs: 1000 }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.hint).toContain("extension_eval");
  });
});
