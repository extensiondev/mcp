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

import { handler } from "../tools/wait";
import { readyContractPath } from "../lib/session-paths";
import { attachedDevContract, errorContract } from "./fixtures/engine-answers";

import type * as EvalModule from "../tools/eval";

const evals = vi.hoisted(() => ({
  answers: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../tools/eval", async (importOriginal) => ({
  ...(await importOriginal<typeof EvalModule>()),
  handler: async (args: Record<string, unknown>) => {
    evals.calls.push(args);
    const next = evals.answers.length > 1 ? evals.answers.shift() : evals.answers[0];

    return JSON.stringify(next);
  },
}));

const EARLIER = "2026-10-05T12:00:00.000Z";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-modes-"));
  evals.answers = [];
  evals.calls = [];
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

function evaluated(value: unknown): Record<string, unknown> {
  return { schema: 1, ok: true, command: "extension_eval", status: "evaluated", value, error: null, warnings: [] };
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

describe("extension_wait until", () => {
  it("polls the eval until it is truthy and answers that value", async () => {
    stamp("chrome", attachedDevContract("chrome"));
    evals.answers = [evaluated(false), evaluated(0), evaluated({ masks: 3 })];

    const result = JSON.parse(
      await handler({
        projectPath: dir,
        browser: "chrome",
        until: { expression: "document.querySelectorAll('.mask').length && { masks: 3 }", context: "page", url: "127.0.0.1:8765" },
        timeoutMs: 5000,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("condition-met");
    expect(result.value.result).toEqual({ masks: 3 });
    expect(result.value.polls).toBe(3);
    expect(evals.calls[0]).toMatchObject({ projectPath: dir, browser: "chrome", context: "page", url: "127.0.0.1:8765" });
  });

  it("answers the last value when the budget runs out", async () => {
    stamp("chrome", attachedDevContract("chrome"));
    evals.answers = [evaluated(null)];

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", until: { expression: "window.ready" }, timeoutMs: 1200 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.error.code).toBe("E_WAIT_TIMEOUT");
    expect(result.value.lastResult).toBeNull();
    expect(result.value.polls).toBeGreaterThan(1);
  });

  it("stops at a refusal that polling cannot change", async () => {
    stamp("chrome", attachedDevContract("chrome"));
    evals.answers = [
      { schema: 1, ok: false, command: "extension_eval", status: "eval-disabled", value: null, error: { code: "E_EVAL_DISABLED", message: "off" }, warnings: [] },
    ];

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", until: { expression: "1" }, timeoutMs: 3000 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("eval-disabled");
    expect(evals.calls).toHaveLength(1);
  });

  it("refuses for: rebuild and until together", async () => {
    stamp("chrome", attachedDevContract("chrome"));

    const result = JSON.parse(
      await handler({ projectPath: dir, browser: "chrome", for: "rebuild", until: { expression: "1" } }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BAD_REQUEST");
  });
});
