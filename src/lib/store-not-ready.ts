// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { EDGE_FIRST_SUBMISSION_STATE, firstSubmissionStep, type EdgeFirstSubmission } from "./edge-first-submission";
import { nextStep, type NextStep } from "./store-connection";

/* @invariant A STORE THAT IS NOT READY FOR REVIEW IS NEVER CALLED GREEN.
 *
 * The checks answer whether a build can be uploaded; the requirements list
 * answers whether the store would take it into review. On 2026-10-26 the
 * Edge preflight read `readyForReview: false` with the first submission
 * missing and still answered "Every check for Edge Add-ons is green" with a
 * submit step (UI ledger). While any store read here is not ready the next
 * step is the move that makes it ready: the Partner Center product page for
 * an Edge product never submitted there, else the project's stores page with
 * the missing inputs named; the upload itself stays possible and is said so.
 */
export function notReadyForReviewStep(
  notReady: string[],
  inputsSay: string,
  edgeFirst: EdgeFirstSubmission | null,
  storesPageUrl: string,
  settingsUrl: string,
): NextStep {
  if (notReady.includes("edge") && edgeFirst && edgeFirst.state === EDGE_FIRST_SUBMISSION_STATE) {
    return firstSubmissionStep(edgeFirst, settingsUrl);
  }

  const say = `${notReady.join(", ")} ${notReady.length === 1 ? "is" : "are"} not ready for review yet.${inputsSay ? ` ${inputsSay}` : ""} Each missing input is named on the project's stores page at ${storesPageUrl}.`;

  return nextStep("configure", say, storesPageUrl);
}

export function notReadyLine(notReady: string[], green: boolean): string {
  if (!notReady.length) return "";

  return green
    ? `${notReady.join(", ")} can take a draft upload but ${notReady.length === 1 ? "is" : "are"} not ready for review, so this is not a green preflight.`
    : `${notReady.join(", ")} ${notReady.length === 1 ? "is" : "are"} not ready for review.`;
}
