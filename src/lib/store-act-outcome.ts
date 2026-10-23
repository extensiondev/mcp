// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { FAILED_STATUSES, linksOf, text, trackLinks, type ActLink, type LinkRow, type Verdict } from "./act-outcome";

import type { PlatformSubmission } from "./platform-submissions";

type Row = Record<string, unknown>;

const LIVE_STATUSES = new Set(["pending", "submitted"]);

export function judgePublish(record: PlatformSubmission): Verdict {
  const state = record.storeReview?.state;
  if (state) return { kind: "recorded", status: "in-review", storeState: state };

  const status = text(record.status).toLowerCase();
  if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

  return { kind: "waiting", status: status || null };
}

/* @invariant A WITHDRAWAL THAT FAILED AT THE STORE IS A RECORDED OUTCOME,
 * NOT A WAIT. The platform's dispatch record reads failed with the store's
 * reason once the run died, and the record stops reading submitted once the
 * store's present is known; either is the answer, and the wait ends there
 * instead of running out its bound on a record that will never move.
 */
export function judgeCancel(record: PlatformSubmission): Verdict {
  const status = text(record.status).toLowerCase();

  if (record.dispatch?.runState === "failed") {
    return { kind: "recorded", status: "cancel-failed", storeState: record.storeReview?.state ?? null, failed: true };
  }

  if (status && !LIVE_STATUSES.has(status)) return { kind: "recorded", status, storeState: record.storeReview?.state ?? null };

  return { kind: "waiting", status: status || null };
}

export function judgeRollout(percentage: number): (rollout: Row) => Verdict {
  return (rollout) => {
    const current = typeof rollout.percentage === "number" ? rollout.percentage : null;
    if (current === percentage) return { kind: "recorded", status: "rollout-raised", storeState: `${current}%` };

    return { kind: "waiting", status: current === null ? null : `${current}%` };
  };
}

export function actLinks(command: string, args: Row, status: string, value: Row, extra: LinkRow[] = [], trackAs: ActLink["kind"] = "track"): ActLink[] {
  const tracked = trackLinks(command, args, status, value).map((row) => (row.kind === "track" ? { ...row, kind: trackAs } : row));

  return linksOf([...tracked, ...extra]);
}

export function trackOf(links: ActLink[]): string {
  return links.find((link) => link.kind !== "item" && link.kind !== "approval")?.url ?? "";
}
