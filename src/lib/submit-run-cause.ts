// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { FIREFOX_SYNC_LISTING_CALL, SAFARI_DESCRIPTION_MAX } from "./store-preflight-local";
import { nextStep, type NextStep } from "./store-connection";
import { installRefusalLine, installRefusedSay } from "./store-refused-install";

type Row = Record<string, unknown>;

export interface RunCause {
  failed: boolean;
  failureReason: string | null;
  nextStep: NextStep | null;
}

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);
const OVERRIDDEN_STATUSES: ReadonlySet<string> = new Set(["pending"]);
const GROUNDED_SOURCES: ReadonlySet<string> = new Set(["poll", "publish-answer", "hand"]);
const GENERIC_REASON = /before the store answered|no submission result was ever read|before any store step ran|finished without reading an answer from the store/i;
const APPLE_DESCRIPTION = /\b90849\b|description field must be present[^.]*?\b112 or fewer characters/i;
const DESCRIPTION_LIMIT = /\bdescription\b[^.]*?\b(\d{2,4}) or fewer characters|\bdescription\b[^.]*?\b(?:over|exceeds|longer than)\b[^.]*?\b(\d{2,4}) characters/i;
const FIREFOX_LISTING = /stores\/firefox\/details\.json does not exist|no firefox listing document/i;
const FIREFOX_LISTING_STEP = /firefox listing/i;
const REASON_MAX = 400;

function trimmed(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();

  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 3).trimEnd()}...` : flat;
}

function row(value: unknown): Row {
  return isRow(value) ? value : {};
}

export function runConcludedFailed(run: Row): boolean {
  const conclusion = text(run.conclusion).toLowerCase();
  const outcome = text(run.outcome).toLowerCase();

  return FAILED_CONCLUSIONS.has(conclusion) || outcome.startsWith("failed");
}

function failedStepOf(submission: Row, run: Row): string {
  return text(run.failedStep) || text(row(submission.failure).step) || text(row(submission.dispatch).failedStep);
}

function reasonsOf(submission: Row, run: Row): string[] {
  return [
    text(submission.failureReason),
    text(row(submission.dispatch).failedReason),
    text(row(submission.storeUpload).message),
    text(run.message),
  ].filter(Boolean);
}

function storeReason(reasons: string[]): string {
  return reasons.find((reason) => !GENERIC_REASON.test(reason)) ?? "";
}

function stepSay(store: string, step: string): string {
  return step ? `The ${store} submit run failed at step "${step}"` : `The ${store} submit run failed`;
}

export function runCauseOf(store: string, submission: Row, run: Row, url: string | null): RunCause {
  const status = text(submission.status).toLowerCase();
  const source = text(row(submission.statusRead).source);
  const live = OVERRIDDEN_STATUSES.has(status) || (status === "submitted" && !GROUNDED_SOURCES.has(source));
  const ranAndFailed = runConcludedFailed(run);
  const failed = status === "failed" || (live && ranAndFailed);

  if (!failed) return { failed: false, failureReason: null, nextStep: null };

  const reasons = reasonsOf(submission, run);
  const step = failedStepOf(submission, run);
  const said = storeReason(reasons);
  const all = [...reasons, step].join(" ");
  const lead = stepSay(store, step);

  if (APPLE_DESCRIPTION.test(all) || (DESCRIPTION_LIMIT.test(all) && /manifest/i.test(all))) {
    const limit = APPLE_DESCRIPTION.test(all) ? SAFARI_DESCRIPTION_MAX : Number(DESCRIPTION_LIMIT.exec(all)?.slice(1).find(Boolean));
    const say = `Shorten the manifest description to ${limit} characters or fewer, build again, and submit the new build; the store refused this one for its description length.`;

    return {
      failed: true,
      failureReason: trimmed(said || `${lead}: the store refused the manifest description as longer than ${limit} characters`),
      nextStep: nextStep("resubmit", say, url ?? undefined),
    };
  }

  if (store === "firefox" && (FIREFOX_LISTING.test(all) || (!said && FIREFOX_LISTING_STEP.test(step)))) {
    const say = `Run ${FIREFOX_SYNC_LISTING_CALL} to write the Firefox listing, then submit again.`;

    return {
      failed: true,
      failureReason: `${lead}: no Firefox listing is on file, so the run could not read it before the upload`,
      nextStep: nextStep("sync-listing", say, url ?? undefined),
    };
  }

  const install = installRefusalLine(reasons);

  if (install) return { failed: true, failureReason: trimmed(install), nextStep: nextStep("resubmit", installRefusedSay(store, install), url ?? undefined) };

  if (said) return { failed: true, failureReason: trimmed(said), nextStep: null };

  const generic = reasons[0] ?? "";
  const why = step ? `${lead}${generic ? `; ${generic.charAt(0).toLowerCase()}${generic.slice(1).replace(/\.$/, "")}` : ""}` : generic || lead;

  return { failed: true, failureReason: trimmed(why), nextStep: null };
}
