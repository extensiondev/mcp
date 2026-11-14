// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as timerSleep } from "node:timers/promises";

export const WAIT_SECONDS_DEFAULT = 180;
export const WAIT_SECONDS_MAX = 600;

export const outcomeClock = {
  now: (): number => Date.now(),
  sleep: async (ms: number): Promise<void> => {
    await timerSleep(ms);
  },
};

export function waitBound(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return WAIT_SECONDS_DEFAULT;

  return Math.min(WAIT_SECONDS_MAX, Math.max(0, Math.floor(n)));
}

export const TRANSIENT_READ_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export function missesSentence(misses: number, waitedSeconds: number, last: string, what = "the record"): string {
  return `${last}; ${misses} ${misses === 1 ? "read" : "reads"} of ${what} missed over ${waitedSeconds} s`;
}
