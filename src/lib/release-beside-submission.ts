// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AMO_SIGNED_STATUS } from "./review-beside-submission";

import type { StoreReleaseState, StoreReleaseView } from "./platform-store-releases";
import type { SubmissionView } from "./store-row-sources";

const STORE_READ_SOURCES: ReadonlySet<string> = new Set(["publish-answer", "poll", "hand"]);

const STATE_OF_WORD: Record<string, StoreReleaseState> = {
  draft: "uploaded",
  uploaded: "uploaded",
  submitted: "in-review",
  "in-review": "in-review",
  in_review: "in-review",
  published: "live",
  live: "live",
  approved: "approved",
  [AMO_SIGNED_STATUS]: "signed",
  rejected: "rejected",
  withdrawn: "withdrawn",
  superseded: "superseded",
};

function sameRelease(row: StoreReleaseView, submission: SubmissionView): boolean {
  if (submission.id && submission.id === row.submissionId) return true;

  const version = submission.storeVersion?.packaged || submission.version || "";

  return Boolean(version) && version === row.version;
}

function unlistedFirefox(row: StoreReleaseView): boolean {
  return row.store === "firefox" && (row.amoChannel === "unlisted" || row.visibility === "unlisted");
}

/* @invariant A RELEASE ROW THE PLATFORM INFERRED NEVER STANDS BESIDE THE
 * SAME SUBMISSION'S STORE READ WITH ANOTHER WORD. The store read of the
 * submission and the release row come from two platform reads of the same
 * record, and one can lag the other: Hands-free's unlisted 0.1.0.1
 * (2026-10-31) read `signed` with AMO's PUBLIC in the submission while the
 * release row still read `in-review (inferred)`. When the submission's word
 * was read from the store and the row's was not, the row takes the
 * submission's state, word, time and source and says where it came from;
 * a row the store answered is never touched. An unlisted Firefox row no
 * store answered is never in review, since AMO signs unlisted uploads
 * without one: it reads uploaded.
 */
export function releaseBesideSubmission(row: StoreReleaseView, submission: SubmissionView | undefined): StoreReleaseView {
  if (row.source !== "inferred") return row;

  const read = submission?.statusRead;

  if (submission && read && STORE_READ_SOURCES.has(read.source) && sameRelease(row, submission)) {
    const word = submission.status === AMO_SIGNED_STATUS ? AMO_SIGNED_STATUS : read.word;
    const state = STATE_OF_WORD[word];

    if (state) {
      return {
        ...row,
        state,
        storeWord: read.storeWord || submission.storeReview?.state || "",
        readAt: read.readAt || row.readAt,
        source: read.source,
        wordTakenFrom: { was: row.state, ...(submission.id ? { submission: submission.id } : {}) },
      };
    }
  }

  if (row.state === "in-review" && unlistedFirefox(row)) {
    return { ...row, state: "uploaded", wordTakenFrom: { was: row.state, channel: "unlisted" } };
  }

  return row;
}
