// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { readyContractPath } from "./session-paths";

export interface ExecutorStamp {
  runtime: "attached" | "detached" | null;
  ts: string | null;
  executorAttachedAt: string | null;
  executorDetachedAt: string | null;
}

/* @invariant THE EXECUTOR'S LIFE IS READ FROM THE CONTRACT, NEVER GUESSED.
 * extension-develop's ready-contract writer (dist/832~0.mjs,
 * `stampExecutorDetached` and `stampExecutorAttached`) stamps
 * `runtime: "detached"` plus `executorDetachedAt` when the last bridge
 * producer's socket closes, and `runtime: "attached"` (deleting
 * `executorDetachedAt`, touching `ts`) when one connects. The first attach
 * sets `executorAttachedAt`; a reattach after a reload keeps that first
 * value and only moves `ts`, so a reattach is proven by `runtime` turning
 * back to attached, or by `ts` moving while runtime reads attached, never by
 * `executorAttachedAt` changing. Both are read here and nowhere else.
 */
export function readExecutorStamp(projectPath: string, browser: string): ExecutorStamp | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    const runtime = contract.runtime === "attached" || contract.runtime === "detached" ? contract.runtime : null;

    return {
      runtime,
      ts: str(contract.ts),
      executorAttachedAt: str(contract.executorAttachedAt),
      executorDetachedAt: str(contract.executorDetachedAt),
    };
  } catch {
    return null;
  }
}

export interface ReattachWatch {
  outcome: "reattached" | "still-detached" | "unobserved" | "unreadable";
  waitedMs: number;
  detachedAt: string | null;
  attachedTs: string | null;
}

const POLL_MS = 20;

export async function watchExecutorReattach(
  projectPath: string,
  browser: string,
  before: ExecutorStamp | null,
  budgetMs: number,
): Promise<ReattachWatch> {
  const started = Date.now();

  if (before === null) {
    return { outcome: "unreadable", waitedMs: 0, detachedAt: null, attachedTs: null };
  }

  let detachedAt: string | null = before.runtime === "detached" ? before.executorDetachedAt : null;

  for (;;) {
    const now = readExecutorStamp(projectPath, browser);
    const waitedMs = Date.now() - started;

    if (now !== null) {
      if (now.runtime === "detached") detachedAt = now.executorDetachedAt ?? detachedAt ?? "an unstated time";

      const cameBack = now.runtime === "attached" && (detachedAt !== null || (now.ts !== null && now.ts !== before.ts));

      if (cameBack) {
        return { outcome: "reattached", waitedMs, detachedAt, attachedTs: now.ts };
      }
    }

    if (waitedMs >= budgetMs) {
      return {
        outcome: detachedAt !== null ? "still-detached" : "unobserved",
        waitedMs,
        detachedAt,
        attachedTs: null,
      };
    }

    await sleep(POLL_MS);
  }
}
