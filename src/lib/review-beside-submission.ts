// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { StoreReview } from "./platform-submissions";

export interface ReviewView {
  status?: string;
  version?: string;
  buildId?: string;
  checkedAt?: string;
  storeState?: string;
  liveState?: string;
  source?: string;
  stale?: true;
  staleReason?: string;
}

export interface ReviewedSubmission {
  version?: string;
  buildSha?: string;
  status?: string;
  storeReview?: StoreReview;
}

const REVIEW_PENDING_STATES = /PENDING|REVIEW|PROGRESS|WAITING|SUBMITTED/;
const REVIEW_APPROVED_STATES = /^PUBLISHED/;
const REVIEW_REJECTED_STATES = /REJECT|CANCEL|TAKEN_DOWN|FAIL/;

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function reviewStatusOf(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "NO_ACTIVE_SUBMISSION") return "draft";
  if (REVIEW_APPROVED_STATES.test(upper)) return "approved";
  if (REVIEW_REJECTED_STATES.test(upper)) return "rejected";
  if (REVIEW_PENDING_STATES.test(upper)) return "pending";

  return state.toLowerCase();
}

function sameBuild(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

const SETTLED_STATUSES: Record<string, string> = {
  published: "approved",
  approved: "approved",
  rejected: "rejected",
  superseded: "superseded",
};

function checkedAtMs(value: string | undefined): number {
  const ms = Date.parse(value ?? "");

  return Number.isFinite(ms) ? ms : 0;
}

function ownReview(submission: ReviewedSubmission, sha: string, status: string): ReviewView {
  const own = submission.storeReview;

  return {
    status,
    ...(submission.version ? { version: submission.version } : {}),
    buildId: sha.slice(0, 7),
    ...(own?.checkedAt ? { checkedAt: own.checkedAt } : {}),
    ...(own?.state ? { storeState: own.state } : {}),
    ...(own?.liveState ? { liveState: own.liveState } : {}),
    ...(own?.source ? { source: own.source } : {}),
  };
}

export function storeReviewOfRow(raw: unknown): StoreReview | undefined {
  if (!isPlainObject(raw)) return undefined;

  const state = str(raw.state);
  if (!state) return undefined;

  const checkedAt = str(raw.checkedAt);
  const source = str(raw.source);
  const liveState = str(raw.liveState);

  return {
    state,
    ...(checkedAt ? { checkedAt } : {}),
    ...(source ? { source } : {}),
    ...(liveState ? { liveState } : {}),
  };
}

/* @invariant THE REVIEW LINE BESIDE A SUBMISSION IS THAT SUBMISSION'S. The
 * poller's review row names the build it checked, and on 2026-10-26 the row
 * for the previous Chrome draft (pending, build e4b8976) sat beside the newer
 * submission 6d9e10c until the next poll, reading as one fact about two
 * builds. A row for another build is answered from the newer submission's
 * own store answer when its record carries one, and otherwise marked stale
 * with the build it belongs to, never shown as the newer submission's review.
 *
 * A row for the same build loses to the submission's own record once that
 * record is settled or carries a newer store answer: the poller keeps the
 * last row it wrote per store, and on 2026-10-27 Rebeccat's 0.2.0.6 read
 * "review pending" beside a record the platform had read live from Chrome
 * itself. A settled record (published, approved, rejected) answers its own
 * verdict whatever the row says.
 */
export function reviewBesideSubmission(
  review: ReviewView | undefined,
  submission: ReviewedSubmission | undefined,
): ReviewView | undefined {
  const sha = str(submission?.buildSha);
  if (!submission || !sha || !review) return review;

  const own = submission.storeReview;
  const settled = SETTLED_STATUSES[String(submission.status ?? "").trim().toLowerCase()];
  const rowIsThisBuild = !review.buildId || sameBuild(sha, review.buildId);

  if (settled) return ownReview(submission, sha, settled);

  if (rowIsThisBuild) {
    return own?.state && checkedAtMs(own.checkedAt) > checkedAtMs(review.checkedAt)
      ? ownReview(submission, sha, reviewStatusOf(own.state))
      : review;
  }

  if (own?.state) return ownReview(submission, sha, reviewStatusOf(own.state));

  return {
    ...review,
    stale: true,
    staleReason: `this review line belongs to build ${review.buildId}; the newer submission ${sha.slice(0, 7)} has not been checked yet`,
  };
}

export function reviewSentence(review: ReviewView): string {
  const checked = review.checkedAt ? `checked ${review.checkedAt}` : "";

  if (review.stale) {
    return `review ${review.status} for build ${review.buildId}${checked ? ` (${checked})` : ""}, stale: ${review.staleReason}`;
  }

  const detail = review.storeState
    ? [review.storeState, review.liveState ? `live item ${review.liveState}` : "", checked].filter(Boolean).join(", ")
    : checked;

  return `review ${review.status}${detail ? ` (${detail})` : ""}`;
}
