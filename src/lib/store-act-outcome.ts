// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { FAILED_STATUSES, after, linksOf, text, trackLinks, type ActLink, type LinkRow, type Verdict } from "./act-outcome";

import type { PlatformSubmission } from "./platform-submissions";

type Row = Record<string, unknown>;

const LIVE_STATUSES = new Set(["pending", "submitted"]);

const REJECTING_STATES = new Set(["REJECTED", "CANCELLED", "CANCELED", "TAKEN_DOWN"]);

export const NO_ACTIVE_SUBMISSION = "NO_ACTIVE_SUBMISSION";

/* @invariant A PUBLISH ANSWERS THE DRAFT'S OWN STATE, READ AFTER THE ACT.
 * The record's review line is also written by polls, and a draft polled
 * before it was sent to review carries the state of the item already live
 * (PUBLISHED for rebeccat on 2026-10-26, while the dashboard said Pending
 * review), so a line checked before the platform accepted the act is not the
 * act's outcome and the wait goes on. The state answered is the submitted
 * draft's; what the store serves meanwhile travels as liveState. A line that
 * says the store holds nothing in review is not a recorded publish either.
 *
 * A PUBLISH THE STORE REFUSED, OR WHOSE RUN DIED BEFORE THE STORE ANSWERED,
 * IS A RECORDED OUTCOME AND NEVER A REVIEW. The record's `publish` block
 * written after the act reads failed with the store's words, or its publish
 * dispatch reads failed with the run's reason, or the store's own operation
 * state reads FAILED (Edge answers that on the publish call itself, and
 * nothing enters certification); each of those ends the wait as
 * publish-failed, so the answer never says the draft is on its way.
 */
export function judgePublish(acceptedAt: string): (record: PlatformSubmission) => Verdict {
  return (record) => {
    const status = text(record.status).toLowerCase();
    if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

    const review = record.storeReview;
    const state = text(review?.state).toUpperCase();
    const liveState = text(review?.liveState).toUpperCase() || null;
    const refused = record.publish?.status === "failed" && after(record.publish.at, acceptedAt);
    const runFailed =
      record.dispatch?.action === "publish" &&
      record.dispatch.runState === "failed" &&
      after(record.dispatch.dispatchedAt, acceptedAt);
    const operationFailed = state === "FAILED" && after(review?.checkedAt, acceptedAt);

    if (refused || runFailed || operationFailed) {
      return { kind: "recorded", status: "publish-failed", storeState: state || null, liveState, failed: true };
    }

    if (!state || state === NO_ACTIVE_SUBMISSION || !after(review?.checkedAt, acceptedAt)) {
      return { kind: "waiting", status: status || null };
    }

    if (REJECTING_STATES.has(state)) return { kind: "recorded", status: "rejected", storeState: state, liveState, failed: true };

    return { kind: "recorded", status: "in-review", storeState: state, liveState };
  };
}

export function publishFailureReason(record: PlatformSubmission | null, fallback: string): string {
  if (!record) return fallback;

  const refusal = record.publish?.status === "failed" ? text(record.publish.storeMessage) : "";
  const runReason = record.dispatch?.action === "publish" && record.dispatch.runState === "failed" ? text(record.dispatch.failedReason) : "";
  const state = text(record.storeReview?.state).toUpperCase();

  return (
    refusal ||
    runReason ||
    text(record.failureReason) ||
    (state === "FAILED" ? "the store answered the publish operation as FAILED, so nothing entered review" : "") ||
    fallback
  );
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
