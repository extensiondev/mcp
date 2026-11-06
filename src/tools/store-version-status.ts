// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { approvalRefundOf, approvalRefundSentence, type ApprovalRefund } from "../lib/approval-refund-words";
import { envelope, isEnvelope } from "../lib/envelope";
import { AMO_FILE_STATUS_LABEL, SIGNED_STATE_SENTENCE, type StoreReleaseView } from "../lib/platform-store-releases";
import { storeUploadOf } from "../lib/platform-submissions";
import { runCauseOf } from "../lib/submit-run-cause";
import { AMO_SIGNED_STATUS } from "../lib/review-beside-submission";
import { consoleProjectUrl } from "../lib/registry";
import { readsBeforeDispatch } from "../lib/store-read-landed";
import { isRow, text } from "../lib/ship-act";
import { type ListingPushView } from "../lib/safari-listing-push-read";
import { releaseChangeOfRow, releaseChangeSentence, releaseTypeMeaning, type ReleaseTypeChange, type ReleaseTypeChangeRefused } from "../lib/store-row-sources";
import { packageRefusedSentence, uploadRefused } from "../lib/store-upload-words";
import { readStores } from "./store-status";

import type { NextStep } from "../lib/store-connection";

const COMMAND = "extension_submit";

const STATUS_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export const STORES_READ_CALL = 'extension_release_status {include: ["stores"]}';

export interface StoreVersionStatus extends ApprovalRefund {
  store: string;
  submissionId: string | null;
  version: string | null;
  buildNumber: number | null;
  status: string | null;
  state: string | null;
  storeMessage?: string;
  failureReason?: string;
  readAt: string | null;
  source: string | null;
  releaseType: string | null;
  releaseTypeChanged?: ReleaseTypeChange;
  releaseTypeChangeRefused?: ReleaseTypeChangeRefused;
  listingPush?: ListingPushView;
  newerDryRun?: NewerDryRun;
  nextStep: NextStep | null;
}

export interface NewerDryRun {
  submissionId: string | null;
  version: string | null;
  submittedAt: string | null;
}

type Row = Record<string, unknown>;

function wantedStores(args: { browsers?: unknown; store?: unknown }): string[] | { refused: string } {
  const named = [
    ...(Array.isArray(args.browsers) ? args.browsers : []),
    ...(text(args.store) ? [args.store] : []),
  ].map((store) => text(store).toLowerCase());
  const unknown = named.filter((store) => !(STATUS_STORES as readonly string[]).includes(store));

  if (unknown.length) return { refused: `status reads ${STATUS_STORES.join(", ")}; got ${unknown.join(", ")}. Nothing was read.` };

  return named.filter((store, index) => named.indexOf(store) === index);
}

const DRY_RUN_STATUSES: ReadonlySet<string> = new Set(["dry_run", "dry-run"]);
const HEADLINE_STATES: ReadonlySet<string> = new Set(["live", "in-review", "approved", "signed"]);

function headlineRelease(row: Row): StoreReleaseView | null {
  const found = [row.release, row.liveRelease].find((release) => isRow(release) && HEADLINE_STATES.has(text(release.state)));

  return found ? (found as unknown as StoreReleaseView) : null;
}

/* @invariant A DRY RUN NEVER HEADLINES A STORE THAT HOLDS A REAL RELEASE,
 * AND NEITHER DOES AN EMPTY SUBMISSION RECORD.
 * A dry run sends nothing to the store, so on Rebeccat (2026-11-06) the
 * status read "chrome 0.3.0: dry_run" while Chrome served 0.3.0.9 as
 * PUBLISHED and Apple held Safari 0.3.0 in WAITING_FOR_REVIEW (ledger 442).
 * When the newest submission record is a dry run, or there is no submission
 * record at all, and the store row carries a live, in-review, approved or
 * signed release, the entry is that release with the store's word (ledger
 * 446). The dry run follows it as newerDryRun only when its submittedAt is
 * after the release's own submittedAt, or its readAt when the release row
 * carries none; an older dry run is not named, since the field claims an
 * order (ledger 447).
 */
function releaseEntryOf(row: Row, release: StoreReleaseView, newerDryRun: Row | null): StoreVersionStatus {
  return {
    store: text(row.store),
    submissionId: text(release.submissionId) || null,
    version: text(release.storeVersion?.packaged) || text(release.version) || null,
    buildNumber: typeof release.storeVersion?.buildNumber === "number" ? release.storeVersion.buildNumber : null,
    status: text(release.state) || null,
    state: text(release.storeWord) || null,
    readAt: text(release.readAt) || null,
    source: text(release.source) || null,
    releaseType: text(release.releaseType) || null,
    ...(isRow(row.listingPush) ? { listingPush: row.listingPush as unknown as ListingPushView } : {}),
    ...(newerDryRun
      ? {
          newerDryRun: {
            submissionId: text(newerDryRun.id) || null,
            version: text(isRow(newerDryRun.storeVersion) ? newerDryRun.storeVersion.packaged : "") || text(newerDryRun.version) || null,
            submittedAt: text(newerDryRun.submittedAt) || null,
          },
        }
      : {}),
    nextStep: isRow(row.nextStep) ? (row.nextStep as unknown as NextStep) : null,
  };
}

function dryRunAfterRelease(submission: Row, release: StoreReleaseView): boolean {
  const dryAt = Date.parse(text(submission.submittedAt));
  const releaseAt = Date.parse(text(release.submittedAt) || text(release.readAt));

  return Number.isFinite(dryAt) && Number.isFinite(releaseAt) && dryAt > releaseAt;
}

function statusOfRow(row: Row, trackUrl = ""): StoreVersionStatus {
  const submission: Row = isRow(row.lastSubmission) ? row.lastSubmission : {};
  const dryRun = DRY_RUN_STATUSES.has(text(submission.status));
  const unrecorded = !text(submission.status) && !text(submission.version);
  const release = dryRun || unrecorded ? headlineRelease(row) : null;
  if (release) return releaseEntryOf(row, release, dryRun && dryRunAfterRelease(submission, release) ? submission : null);

  const read: Row = isRow(submission.statusRead) ? submission.statusRead : {};
  const review: Row = isRow(submission.storeReview) ? submission.storeReview : {};
  const upload = storeUploadOf(submission.storeUpload);
  const storeVersion: Row = isRow(submission.storeVersion) ? submission.storeVersion : {};
  const buildNumber = typeof storeVersion.buildNumber === "number" ? storeVersion.buildNumber : null;
  const run: Row = isRow(row.submissionRun) ? row.submissionRun : {};
  const cause = runCauseOf(text(row.store), submission, run, trackUrl || null);
  const overridden = cause.failed && text(submission.status) !== "failed";
  const ownStep = !uploadRefused(upload) && isRow(row.nextStep) ? (row.nextStep as unknown as NextStep) : null;

  return {
    store: text(row.store),
    submissionId: text(submission.id) || null,
    version: text(storeVersion.packaged) || text(submission.version) || null,
    buildNumber,
    status: cause.failed ? "failed" : text(submission.status) || null,
    state: overridden ? upload?.state || null : text(read.storeWord) || upload?.state || text(review.state) || null,
    ...(upload?.message ? { storeMessage: upload.message } : {}),
    ...(cause.failureReason ? { failureReason: cause.failureReason } : {}),
    readAt: overridden ? null : text(read.readAt) || upload?.checkedAt || text(review.checkedAt) || null,
    source: overridden ? "run" : text(read.source) || upload?.source || null,
    releaseType: text(submission.releaseType) || null,
    ...releaseChangeOfRow(submission),
    ...approvalRefundOf(submission),
    ...(isRow(row.listingPush) ? { listingPush: row.listingPush as unknown as ListingPushView } : {}),
    nextStep: cause.nextStep ?? (cause.failed ? null : ownStep),
  };
}

function landedUnsourced(entry: StoreVersionStatus, refresh: Row | null, wait: Row | null): string {
  const own = refresh?.[entry.store];
  const dispatchedAt = isRow(own) ? text(own.dispatchedAt) : "";
  const readAt = Date.parse(entry.readAt ?? "");
  if (entry.source || wait?.landed !== true || !dispatchedAt || !(readAt >= Date.parse(dispatchedAt))) return "";

  return ` (the store check this call asked for landed at ${entry.readAt}, after its dispatch at ${dispatchedAt}, but the platform answered no source for that read, so it grounds no next step)`;
}

export function storeVersionSentence(entry: StoreVersionStatus, refresh: Row | null, wait: Row | null): string {
  const push = entry.listingPush ? `; ${entry.listingPush.say.charAt(0).toLowerCase()}${entry.listingPush.say.slice(1)}` : "";

  return `${submissionSentence(entry, refresh, wait)}${push}`;
}

function submissionSentence(entry: StoreVersionStatus, refresh: Row | null, wait: Row | null): string {
  if (!entry.version && !entry.status) return `${entry.store}: no submission recorded`;

  const build = entry.buildNumber ? ` build ${entry.buildNumber}` : "";
  const signed = entry.store === "firefox" && entry.status === AMO_SIGNED_STATUS;
  const status = signed ? SIGNED_STATE_SENTENCE : entry.status ?? "recorded";
  const refused = packageRefusedSentence(entry.store, entry.state ? { state: entry.state, message: entry.storeMessage } : undefined);
  const state = refused ? `, ${refused}` : entry.state ? `, ${signed ? AMO_FILE_STATUS_LABEL : "the store says"} ${entry.state}` : "";
  const read = entry.source
    ? ` (${entry.source}${entry.readAt ? ` at ${entry.readAt}` : ""})`
    : landedUnsourced(entry, refresh, wait) || " (no store read behind it)";
  const meaning = releaseTypeMeaning(entry.releaseType ?? undefined);
  const change = releaseChangeSentence(entry);
  const release = entry.releaseType ? `, release type ${entry.releaseType}${meaning ? ` (${meaning})` : ""}${change ? `, ${change}` : ""}` : "";
  const refund = approvalRefundSentence(entry);
  const reason = entry.failureReason && !refused ? `: ${entry.failureReason.replace(/\.$/, "")}` : "";
  const next = entry.nextStep ? `. Next: ${entry.nextStep.say}` : "";
  const dry = entry.newerDryRun ? `; ${newerDryRunSentence(entry.newerDryRun)}` : "";

  return `${entry.store} ${entry.version ?? ""}${build}: ${status}${reason}${state}${read}${release}${refund ? `; ${refund}` : ""}${dry}${next}`;
}

function newerDryRunSentence(dry: NewerDryRun): string {
  return `a newer dry run${dry.version ? ` of ${dry.version}` : ""}${dry.submittedAt ? ` at ${dry.submittedAt}` : ""} sent nothing to the store`;
}

const STEP_ORDER = ["release", "watch"];

function overallStep(entries: StoreVersionStatus[]): NextStep | null {
  const steps = entries.map((entry) => entry.nextStep).filter((step): step is NextStep => Boolean(step));

  return steps.sort((a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind))[0] ?? null;
}

export async function storeVersionStatus(args: {
  project?: string;
  browsers?: unknown;
  store?: unknown;
  waitSeconds?: unknown;
  api?: string;
}): Promise<string> {
  const wanted = wantedStores(args);

  if (!Array.isArray(wanted)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      error: { code: "E_BAD_REQUEST", name: "StatusInputError", message: wanted.refused },
    });
  }

  const raw = await readStores({
    project: args.project,
    api: args.api,
    caller: COMMAND,
    ...(args.waitSeconds !== undefined && wanted.length ? { refresh: wanted, waitSeconds: args.waitSeconds } : {}),
  });
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!isEnvelope(parsed) || parsed.ok !== true) {
    const frame: Row = isRow(parsed) ? parsed : {};
    const refused: Row = isRow(frame.value) ? frame.value : {};
    const refusedRef = text(refused.workspace) && text(refused.project) ? { workspace: text(refused.workspace), project: text(refused.project) } : null;
    const storePage = wanted.length === 1 && refusedRef && text(refused.trackUrl) ? consoleProjectUrl(refusedRef, ConsoleProjectPage.submissionsStore(wanted[0] ?? ""), args.api) : "";
    const hint = typeof frame.hint === "string" && storePage ? frame.hint.split(text(refused.trackUrl)).join(storePage) : frame.hint;

    return envelope({
      ok: false,
      command: COMMAND,
      status: text(frame.status) || "unavailable",
      value: storePage ? { ...refused, trackUrl: storePage, nextStep: isRow(refused.nextStep) ? { ...refused.nextStep, url: storePage } : refused.nextStep } : refused,
      error: isRow(frame.error)
        ? (frame.error as { code: "E_PLATFORM"; name?: string; message: string })
        : { code: "E_PLATFORM", name: "StatusUnavailable", message: "the store read answered nothing usable" },
      ...(typeof hint === "string" ? { hint } : {}),
    });
  }

  const value: Row = isRow(parsed.value) ? parsed.value : {};
  const rows = (Array.isArray(value.stores) ? value.stores : []).filter(isRow);
  const picked = wanted.length
    ? wanted.map((store) => rows.find((row) => row.store === store) ?? { store })
    : rows.filter((row) => row.configured === true || isRow(row.lastSubmission));
  const ref = text(value.workspace) && text(value.project) ? { workspace: text(value.workspace), project: text(value.project) } : null;
  const stores = picked.map((row) => statusOfRow(row, ref ? consoleProjectUrl(ref, ConsoleProjectPage.submissionsStore(text(row.store)), args.api) : ""));
  const step = overallStep(stores);
  const wait = isRow(value.refreshWait) ? value.refreshWait : null;
  const refresh = isRow(value.refresh) ? value.refresh : null;
  const waitSentence = wait
    ? wait.landed === true
      ? `The store check this call asked for landed within ${String(wait.waitedSeconds)} s, so these are the states it read. `
      : `The store check this call asked for had not landed after ${String(wait.waitedSeconds)} s, so these are the states before it${readsBeforeDispatch(stores, refresh)}. `
    : "";
  const trackUrl = stores.length === 1 && ref ? consoleProjectUrl(ref, ConsoleProjectPage.submissionsStore(stores[0].store), args.api) : text(value.consoleStoresUrl);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "status-read",
    value: {
      action: "status",
      workspace: value.workspace,
      project: value.project,
      stores,
      ...(refresh ? { refresh } : {}),
      ...(wait ? { refreshWait: wait } : {}),
      nextStep: step,
      trackUrl: trackUrl || undefined,
    },
    hint: `${waitSentence}${stores.length ? stores.map((entry) => storeVersionSentence(entry, refresh, wait)).join(". ") : "No store has a submission recorded"}. This reads the same store records as ${STORES_READ_CALL}, which answers the full store picture; only a state a store check or the publish answer read grounds a next step.`,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
  });
}
