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
  storeVersion?: { packaged: string };
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

export const REVIEW_WITHDRAWN_STATES: ReadonlySet<string> = new Set(["DEVELOPER_REJECTED"]);

/* @invariant APPLE'S DEVELOPER_REJECTED IS A WITHDRAWAL, NEVER A REJECTION.
 * App Store Connect names a version the developer removed from review
 * DEVELOPER_REJECTED, whether the platform's cancel act did it or the owner
 * did it by hand in App Store Connect; Apple's own refusal is REJECTED (and
 * METADATA_REJECTED, INVALID_BINARY). Rebeccat 2026-10-28 read "review
 * rejected (DEVELOPER_REJECTED)" the day after it withdrew 0.2.0 itself, so
 * the word is decided before the rejection pattern can match the suffix. */
export function reviewStatusOf(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "NO_ACTIVE_SUBMISSION") return "draft";
  if (REVIEW_WITHDRAWN_STATES.has(upper)) return "withdrawn";
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

function storeVersionOf(submission: ReviewedSubmission): string | undefined {
  return str(submission.storeVersion?.packaged) || str(submission.version);
}

export function ownReview(submission: ReviewedSubmission, sha: string, status: string): ReviewView {
  const own = submission.storeReview;
  const version = storeVersionOf(submission);

  return {
    status,
    ...(version ? { version } : {}),
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
  store?: string,
): ReviewView | undefined {
  const sha = str(submission?.buildSha);
  if (!submission || !sha || !review) return review;

  const own = submission.storeReview;
  const settled = SETTLED_STATUSES[String(submission.status ?? "").trim().toLowerCase()];

  if (store === "firefox") return firefoxReviewBeside(review, submission, sha, settled);

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

/* @invariant A FIREFOX REVIEW LINE IS KEYED ON THE VERSION AMO HOLDS, NEVER
 * ON THE BUILD. One build reaches AMO as several versions (Rebeccat
 * 2026-10-29: 0.2.0.7 listed and in review, 0.2.0.8 unlisted and signed,
 * both from 069d4b8), and AMO reviews each version on its own. The poll's
 * row names the manifest version and the build, so it is this submission's
 * line only when it names the stamped version the submission sent; otherwise
 * the submission's own record answers with AMO's state for that version,
 * and with none read yet the row is marked stale with the version it names.
 */
function firefoxReviewBeside(
  review: ReviewView,
  submission: ReviewedSubmission,
  sha: string,
  settled: string | undefined,
): ReviewView {
  const own = submission.storeReview;
  const version = storeVersionOf(submission);

  if (settled) return ownReview(submission, sha, settled);

  if (version && review.version === version) {
    return own?.state && checkedAtMs(own.checkedAt) > checkedAtMs(review.checkedAt)
      ? ownReview(submission, sha, reviewStatusOf(own.state))
      : review;
  }

  if (own?.state) return ownReview(submission, sha, reviewStatusOf(own.state));

  return {
    ...review,
    stale: true,
    staleReason: `this review line names version ${review.version || "unknown"} of build ${review.buildId || "unknown"}; AMO's state for ${version || "the newer submission"} has not been read yet`,
  };
}

const UPLOAD_ONLY_STATUSES = new Set(["draft", "uploaded", "pending", "dry-run", "dry_run", "queued"]);

/* @invariant AN UPLOAD THAT ENTERED NO REVIEW NEVER REWRITES THE STORE'S
 * REVIEW LINE, AND A LINE WITH NO STORE WORD IS NEVER "PENDING". Rebeccat
 * 2026-10-29: a three-store draft upload of e679664 turned Chrome's line
 * from approved (0.2.0.7, still published) into "review pending for build
 * 6d9e10c", and Safari's from DEVELOPER_REJECTED into a pending line from
 * before the withdrawal with no Apple state. While the newest submission is
 * an upload with no store answer of its own, the line answers the newest
 * store answer any submission of that store carries (what the store reviewed
 * or serves, with its state, source and date), else the poll's row only when
 * it carries the store's state and source; a pending line that names neither
 * is not shown.
 */
export function storeReviewLine(args: {
  store: string;
  row: ReviewView | undefined;
  latest: (ReviewedSubmission & { submittedAt?: string }) | undefined;
  earlier: Array<ReviewedSubmission & { submittedAt?: string }>;
}): ReviewView | undefined {
  const { latest } = args;
  const uploadOnly =
    latest !== undefined &&
    !latest.storeReview?.state &&
    UPLOAD_ONLY_STATUSES.has(String(latest.status ?? "").trim().toLowerCase());
  const read = (review: ReviewView | undefined) => (review && review.storeState && review.source ? review : undefined);

  const review = uploadOnly
    ? newestAnswered(args.earlier) ?? read(args.row)
    : reviewBesideSubmission(args.row, latest, args.store);

  if (!review) return undefined;
  if (review.status === "pending" && !review.storeState && !review.source) return undefined;

  return review;
}

function newestAnswered(records: ReviewedSubmission[]): ReviewView | undefined {
  const answered = records
    .filter((record) => record.storeReview?.state && str(record.buildSha))
    .sort((a, b) => checkedAtMs(b.storeReview?.checkedAt) - checkedAtMs(a.storeReview?.checkedAt))[0];

  if (!answered?.storeReview) return undefined;

  const settled = SETTLED_STATUSES[String(answered.status ?? "").trim().toLowerCase()];

  return ownReview(answered, String(answered.buildSha), settled ?? reviewStatusOf(answered.storeReview.state));
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
