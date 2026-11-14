// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as timerSleep } from "node:timers/promises";

export const WAIT_SECONDS_DEFAULT = 180;
export const WAIT_SECONDS_MAX = 600;

export const outcomeClock = {
  now: (): number => Date.now(),
  sleep: async (ms: number): Promise<void> => {
    await timerSleep(ms);
  },
};

export interface WaitCut {
  askedSeconds: number;
  grantedSeconds: number;
  until: number;
}

export interface CallDeadline {
  waitsEndAt: number;
  dispatchesEndAt: number;
  readsEndAt: number;
  cuts: WaitCut[];
}

const callDeadlines = new AsyncLocalStorage<CallDeadline>();

/* @invariant NOTHING A TOOL WAITS ON OUTLIVES THE CALL THAT HOLDS IT. On this
 * machine a call has no limit of its own, so a wait runs to the bound the
 * caller asked for, or to the tool's default when none was asked, and a
 * platform request gets its whole budget. A host that ends every call at a
 * fixed time (the hosted lane's function) runs the tool inside
 * withCallDeadline: every wait bound a tool computes, asked or defaulted, is
 * cut to the seconds left before waitsEndAt, and every platform request is
 * cut to the time left before its kind's end (a dispatch before a read, so
 * a dispatch that got no answer still has time to be read back). Each wait
 * cut is recorded on the scope with the moment it runs out, so the host can
 * say a wait was shortened only when the tool really waited that long.
 */
export function withCallDeadline<T>(deadline: CallDeadline, run: () => T): T {
  return callDeadlines.run(deadline, run);
}

export function underWaitDeadline(seconds: number): number {
  const deadline = callDeadlines.getStore();
  if (!deadline) return seconds;

  const now = outcomeClock.now();
  const left = Math.max(0, Math.floor((deadline.waitsEndAt - now) / 1000));
  if (seconds <= left) return seconds;

  deadline.cuts.push({ askedSeconds: seconds, grantedSeconds: left, until: now + left * 1000 });

  return left;
}

export function underCallDeadline(kind: "read" | "dispatch", boundMs: number): number {
  const deadline = callDeadlines.getStore();
  if (!deadline) return boundMs;

  const left = (kind === "dispatch" ? deadline.dispatchesEndAt : deadline.readsEndAt) - outcomeClock.now();

  return Math.max(1_000, Math.min(boundMs, left));
}

export function waitBound(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return underWaitDeadline(WAIT_SECONDS_DEFAULT);

  return underWaitDeadline(Math.min(WAIT_SECONDS_MAX, Math.max(0, Math.floor(n))));
}

export const TRANSIENT_READ_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export function missesSentence(misses: number, waitedSeconds: number, last: string, what = "the record"): string {
  return `${last}; ${misses} ${misses === 1 ? "read" : "reads"} of ${what} missed over ${waitedSeconds} s`;
}
