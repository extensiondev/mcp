// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as sleep } from "node:timers/promises";

import { WEBKIT_FAMILY } from "./browser-family";
import { envelope, type EnvelopeError } from "./envelope";

export interface EvalUntil {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 50_000;
const DEFAULT_INTERVAL_MS = 500;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 10_000;
const MIN_POLL_TIMEOUT_MS = 300;

export const EVAL_UNTIL_PROPERTY = {
  type: "object",
  description:
    "Repeat the eval until it returns a truthy value, for a condition that is still settling (a model loading, an element appearing), instead of answering the first reading. Pass {} for the defaults. Answers status \"condition-met\" with value.result (the truthy value) and value.polls, or status \"timeout\" (E_WAIT_TIMEOUT) with value.lastResult, the last value read. A refusal polling cannot change (eval disabled, no such surface, an ended Safari session) answers at once. Works on Chromium, Firefox and Safari sessions. Never sleep or tail the session log in a shell to wait.",
  properties: {
    timeoutMs: {
      type: "number",
      default: DEFAULT_TIMEOUT_MS,
      description: `Budget for the whole wait. Default ${DEFAULT_TIMEOUT_MS}, clamped to ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} so one call stays under the client's 60s request timeout. On timeout, call again to keep waiting.`,
    },
    intervalMs: {
      type: "number",
      default: DEFAULT_INTERVAL_MS,
      description: `Pause between evals. Default ${DEFAULT_INTERVAL_MS}, clamped to ${MIN_INTERVAL_MS}-${MAX_INTERVAL_MS}.`,
    },
  },
};

const TERMINAL_EVAL_STATUSES = new Set([
  "eval-disabled",
  "bad-request",
  "no-extension-id",
  "no-surface",
  "webdriver-session-ended",
  "safari-context-unreachable",
  "input-invalid",
  "browser-required",
]);

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, Math.round(value)));
}

function truthy(value: unknown): boolean {
  return Boolean(value) && !(typeof value === "number" && Number.isNaN(value));
}

function resultOf(frame: { value?: unknown }, browser: string, context: string | undefined): unknown {
  const value = frame.value as Record<string, unknown> | null | undefined;

  if (
    WEBKIT_FAMILY.has(browser) &&
    context === "page" &&
    value &&
    typeof value === "object" &&
    "result" in value &&
    value.context === "page" &&
    value.browser === browser
  ) {
    return value.result;
  }

  return frame.value ?? null;
}

export function pollTimeoutWithin(callTimeoutMs: number | undefined, remainingMs: number): number {
  const bounded = Math.max(MIN_POLL_TIMEOUT_MS, Math.round(remainingMs));

  return typeof callTimeoutMs === "number" && Number.isFinite(callTimeoutMs) ? Math.min(callTimeoutMs, bounded) : bounded;
}

export async function evalUntilTruthy(
  command: string,
  evaluate: (pollTimeoutMs: number) => Promise<string>,
  browser: string,
  context: string | undefined,
  until: EvalUntil,
): Promise<string> {
  const budgetMs = clamp(until.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const intervalMs = clamp(until.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const start = Date.now();
  let polls = 0;
  let lastResult: unknown = null;
  let lastStatus: string | null = null;
  let lastError: unknown = null;
  let warnings: string[] = [];

  while (polls === 0 || Date.now() - start < budgetMs) {
    polls += 1;
    const raw = await evaluate(pollTimeoutWithin(undefined, budgetMs - (Date.now() - start)));
    let frame: { ok: boolean; status: string; value?: unknown; error?: unknown; warnings?: string[] };

    try {
      frame = JSON.parse(raw);
    } catch {
      return raw;
    }

    lastStatus = frame.status;
    warnings = Array.isArray(frame.warnings) ? frame.warnings : [];

    if (frame.ok) {
      lastResult = resultOf(frame, browser, context);
      lastError = null;

      if (truthy(lastResult)) {
        return envelope({
          ok: true,
          command,
          status: "condition-met",
          value: { result: lastResult, polls, browser, budgetMs, intervalMs, elapsedMs: Date.now() - start },
          warnings,
          hint: "The expression evaluated truthy; value.result is what it returned on that poll.",
        });
      }
    } else {
      lastError = frame.error ?? null;

      if (TERMINAL_EVAL_STATUSES.has(frame.status)) {
        return envelope({
          ok: false,
          command,
          status: frame.status,
          error: frame.error as EnvelopeError,
          value: { polls, budgetMs, intervalMs, elapsedMs: Date.now() - start },
          warnings,
          hint: `The eval was refused for a reason polling cannot change; fix that (the error says what), then call ${command} with until again.`,
        });
      }
    }

    if (Date.now() - start + intervalMs >= budgetMs) break;

    await sleep(intervalMs);
  }

  return envelope({
    ok: false,
    command,
    status: "timeout",
    error: {
      code: "E_WAIT_TIMEOUT",
      message: `The expression did not evaluate truthy in ${polls} poll${polls === 1 ? "" : "s"} over ${Date.now() - start} ms.`,
    },
    value: { lastResult, lastStatus, ...(lastError ? { lastError } : {}), polls, budgetMs, intervalMs, elapsedMs: Date.now() - start },
    warnings,
    hint: `Call ${command} with the same expression and until to keep waiting; value.lastResult is the value the last poll returned${lastError ? ", and value.lastError why the last poll failed" : ""}. Never sleep or tail the session log in a shell to wait.`,
  });
}
