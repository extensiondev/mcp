// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import {
  consoleProjectUrl,
  fetchRegistryJson,
  registryFileUrl,
  resolveProjectRef,
  type ProjectRef,
} from "../lib/registry";
import { envelope, type ErrorCode } from "../lib/envelope";
import { platformHoldEnvelope } from "../lib/platform-hold";
import {
  isNewerOrSame,
  queuedActSentence,
  readPlatformSubmissions,
  retryNote,
  statusReadOf,
  type QueuedStoreActView,
  type StoreReview,
  type StoreStatusRead,
  type SubmissionRun,
} from "../lib/platform-submissions";
import {
  AMO_SIGNED_STATUS,
  amoUnlistedSigning,
  storeReviewLine,
  reviewSentence,
  storeReviewOfRow,
  type ReviewView,
} from "../lib/review-beside-submission";
import {
  earlierSubmissions,
  findStoreSubmission,
  readPlatformStoreRecords,
  readStoreSubmissionById,
  type StoreHistoryEntry,
  type SubmissionLookup,
} from "../lib/platform-store-records";
import { repairEdgeStoreUrl } from "../lib/edge-listing";
import { storeRecordUnread } from "../lib/store-readiness";
import { openProjectApi, projectApiSend } from "../lib/project-api";
import { outcomeClock, waitBound } from "../lib/act-outcome";
import { nextStep, type NextStep } from "../lib/store-connection";
import {
  liveStoreReleaseOf,
  newestStoreReleaseByLane,
  newestStoreReleaseByStore,
  readPlatformStoreReleases,
  storeReleaseSentence,
  type StoreReleaseView,
} from "../lib/platform-store-releases";

export const REFRESHABLE_STORES = ["chrome", "edge", "firefox", "safari"] as const;

export interface StoreReadView {
  state: "live" | "absent" | "unreadable" | "unresolved";
  version?: string;
  manifestVersion?: string;
  listingUrl?: string;
  checkedAt?: string;
  reason?: string;
}

export interface StoreRefreshView {
  dispatched: boolean;
  queued: boolean;
  dispatchedAt?: string;
  dueAt?: string;
  message?: string;
  storeRead?: StoreReadView;
}

function storeReadOf(raw: unknown): StoreReadView | undefined {
  if (!isPlainObject(raw)) return undefined;

  const state = str(raw.state);

  if (state !== "live" && state !== "absent" && state !== "unreadable" && state !== "unresolved") return undefined;

  const view: StoreReadView = { state };

  for (const key of ["version", "manifestVersion", "listingUrl", "checkedAt", "reason"] as const) {
    const value = str(raw[key]);
    if (value) view[key] = value;
  }

  return view;
}

/* @invariant A REFRESH READS THE STORE AGAIN AND ACTS ON NOTHING. For each
 * store named it asks the platform for one poll now under the stored login,
 * a member's read with no approval; the platform bounds it (one per project
 * per two minutes, the GitHub budget) and the answer carries what it did:
 * dispatched, queued for the budget reset, or refused in its own words.
 * The registry the rest of this read answers from reflects the poll a
 * minute or two later, so the hint says to read again, never that the
 * state already changed.
 */
export async function refreshStores(args: {
  stores: string[];
  project?: string;
  api?: string;
}): Promise<Record<string, StoreRefreshView>> {
  const wanted = args.stores
    .map((store) => String(store || "").trim().toLowerCase())
    .filter((store, index, all) => (REFRESHABLE_STORES as readonly string[]).includes(store) && all.indexOf(store) === index);
  const out: Record<string, StoreRefreshView> = {};

  if (!wanted.length) return out;

  const opened = await openProjectApi({ command: "extension_release_status", project: args.project, api: args.api });

  if (!opened.ok) {
    for (const store of wanted) out[store] = { dispatched: false, queued: false, message: opened.message };

    return out;
  }

  for (const store of wanted) {
    const sent = await projectApiSend<Record<string, unknown>>(opened.api, "POST", `stores/${store}/poll`, {});

    if (!sent.ok) {
      out[store] = { dispatched: false, queued: false, message: sent.message };
      continue;
    }

    const json = sent.json ?? {};
    const dispatchedAt = str(json.dispatchedAt);
    const dueAt = str(json.dueAt);
    const message = str(json.message);

    const storeRead = storeReadOf(json.storeRead);

    out[store] = {
      dispatched: json.dispatched === true,
      queued: json.queued === true,
      ...(dispatchedAt ? { dispatchedAt } : {}),
      ...(dueAt ? { dueAt } : {}),
      ...(message ? { message } : {}),
      ...(storeRead ? { storeRead } : {}),
    };
  }

  return out;
}

const KNOWN_STORES = ["chrome", "firefox", "edge", "safari"] as const;

interface HealthRow {
  ok?: boolean;
  message?: string;
  checkedAt?: string;
}

interface SubmissionView {
  id?: string;
  version?: string;
  status?: string;
  storeUrl?: string;
  submittedAt?: string;
  channel?: string;
  buildSha?: string;
  storeSubmissionId?: string;
  failureReason?: string;
  supersededBy?: string;
  storeVersion?: { packaged: string; displayed: string; source: string; buildNumber?: number };
  storeCrxVersion?: string;
  storeReview?: StoreReview;
  statusRead?: StoreStatusRead;
  releaseType?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(at: string | undefined): string {
  const date = new Date(String(at ?? ""));

  return Number.isFinite(date.getTime()) ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}` : "";
}

const APPLE_STATE_WORDS: Record<string, string> = {
  WAITING_FOR_REVIEW: "waiting for review",
  IN_REVIEW: "in review",
  READY_FOR_REVIEW: "ready for review",
  PENDING_DEVELOPER_RELEASE: "approved, waiting for a manual release",
  READY_FOR_SALE: "on sale",
  DEVELOPER_REJECTED: "withdrawn",
  REJECTED: "rejected",
  METADATA_REJECTED: "rejected",
};

/* @invariant A SAFARI WITHDRAWAL STAYS IN THE SUMMARY BESIDE THE NEXT REVIEW.
 * Rebeccat 2026-10-29: build 11 of 0.2.0 was withdrawn on 10-28 and build 14
 * of the same version went to App Review, and the summary described only the
 * new review, so the withdrawal showed nowhere. The newest withdrawn record
 * in the history is named with its build and day beside the latest
 * submission's own App Review state: "0.2.0: build 11 withdrawn Oct 28;
 * build 14 waiting for review".
 */
export function safariWithdrawalSentence(
  latest: SubmissionView | undefined,
  earlier: StoreHistoryEntry[],
): string {
  if (latest?.status === "withdrawn") return "";

  const withdrawn = earlier
    .filter((entry) => entry.status === "withdrawn")
    .sort((a, b) =>
      String(b.statusReadAt ?? b.submittedAt ?? "").localeCompare(String(a.statusReadAt ?? a.submittedAt ?? "")),
    )[0];
  if (!withdrawn) return "";

  const version = withdrawn.storeVersion?.packaged || withdrawn.version || "";
  const number = withdrawn.storeVersion?.buildNumber;
  const day = shortDay(withdrawn.statusReadAt);
  const head = `${number ? `build ${number}` : `build ${withdrawn.buildSha || "unknown"}`} withdrawn${day ? ` ${day}` : ""}`;

  if (!latest) return `${version}: ${head}`;

  const latestVersion = latest.storeVersion?.packaged || latest.version || "";
  const latestNumber = latest.storeVersion?.buildNumber;
  const state = latest.storeReview?.state ? APPLE_STATE_WORDS[latest.storeReview.state] : undefined;
  const latestWords = `${latestNumber ? `build ${latestNumber}` : `build ${latest.buildSha || "unknown"}`} ${state || latest.status || "recorded"}`;

  return latestVersion === version
    ? `${version}: ${head}; ${latestWords}`
    : `${version} ${head}; ${latestVersion} ${latestWords}`;
}

const RELEASE_MODE_WORDS: Record<string, string> = {
  AFTER_APPROVAL: "is set to release automatically after approval",
  MANUAL: "is set to manual release",
  SCHEDULED: "is set to a scheduled release",
};

export function safariReleaseSentence(latest: SubmissionView | undefined): string {
  const type = latest?.releaseType || (latest as { publish?: { releaseType?: string } } | undefined)?.publish?.releaseType;
  const words = type ? RELEASE_MODE_WORDS[type] : undefined;
  if (!latest || !words) return "";

  return `${latest.storeVersion?.packaged || latest.version || "the version"} ${words}`;
}

const APPLE_PENDING_DEVELOPER_RELEASE = "PENDING_DEVELOPER_RELEASE";

export const SAFARI_RELEASE_CALL = 'extension_submit {action: "release", browsers: ["safari"]}';

/* @invariant A VERSION APPLE APPROVED FOR MANUAL RELEASE NAMES THE RELEASE
 * ACT, AND ONLY WHEN THE STORE'S WORD WAS READ. App Store Connect holds such
 * a version as PENDING_DEVELOPER_RELEASE; the platform answers it approved,
 * and on 2026-10-30 it read "submitted" with no next step while the Release
 * act waited. A word the platform inferred grounds no next step.
 */
export function safariReleaseStepSentence(latest: SubmissionView | undefined): string {
  if (!latest || groundedAppleState(latest) !== APPLE_PENDING_DEVELOPER_RELEASE) return "";

  const version = latest.storeVersion?.packaged || latest.version || "the version";
  const build = latest.storeVersion?.buildNumber ? ` (build ${latest.storeVersion.buildNumber})` : "";

  return `Apple approved ${version}${build} and holds it for your release (${APPLE_PENDING_DEVELOPER_RELEASE}); to put it on sale, call ${SAFARI_RELEASE_CALL}, which a workspace owner approves once`;
}

const APPLE_REVIEW_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_REVIEW"]);

export const SAFARI_FRESH_READ_CALL =
  'extension_release_status {include: ["stores"], refresh: ["safari"], waitSeconds: 180}';

function groundedAppleState(latest: SubmissionView): string {
  const read = latest.statusRead;
  if (!read || (read.source !== "poll" && read.source !== "publish-answer")) return "";

  return (read.storeWord || latest.storeReview?.state || "").toUpperCase();
}

export function safariNextStep(latest: SubmissionView | undefined, url: string): NextStep | null {
  const state = latest ? groundedAppleState(latest) : "";
  if (!latest || !state) return null;

  const version = latest.storeVersion?.packaged || latest.version || "the version";
  const build = latest.storeVersion?.buildNumber ? ` (build ${latest.storeVersion.buildNumber})` : "";
  const readAt = latest.statusRead?.readAt ? `, read at ${latest.statusRead.readAt}` : "";

  if (state === APPLE_PENDING_DEVELOPER_RELEASE) {
    return nextStep("release", `${safariReleaseStepSentence(latest)}${readAt}.`, url);
  }

  if (APPLE_REVIEW_STATES.has(state)) {
    return nextStep(
      "watch",
      `Apple holds ${version}${build} as ${state}${readAt}: wait for Apple's review, there is nothing to send meanwhile. To read Apple's state again in one call, call ${SAFARI_FRESH_READ_CALL}; once it reads ${APPLE_PENDING_DEVELOPER_RELEASE}, call ${SAFARI_RELEASE_CALL}.`,
      url,
    );
  }

  return null;
}

/* @invariant A WORD THE PLATFORM INFERRED IS SAID TO BE INFERRED, AND IT
 * GROUNDS NO NEXT STEP. The platform answers each submission's status with
 * where its word was read (the publish answer, a poll, the run) or says it
 * inferred it from its own record; the hint repeats that label so an agent
 * reading "submitted (inferred)" asks for a store check instead of acting
 * on it, which is Cezar's decision B of 2026-10-28 after Rebeccat's record
 * drifted from the stores a dozen times in eleven days.
 */
export function statusReadNote(read: StoreStatusRead | undefined): string {
  if (!read) return "";

  if (read.source === "inferred") {
    return " (inferred: the platform has no store answer behind this word, so it grounds no next step; ask for a store check with refresh)";
  }

  if (read.source === "hand") {
    return ` (recorded by hand from the store's own dashboard${read.readAt ? ` at ${read.readAt}` : ""}, not read by a store check${read.note ? `: ${read.note}` : ""})`;
  }

  if (read.source === "unknown") {
    return ` (read by a source this MCP does not know${read.sourceWord ? ` (${read.sourceWord})` : ""}${read.readAt ? ` at ${read.readAt}` : ""}, so it grounds no next step; update the MCP to read it)`;
  }

  const where = read.source === "run" ? "the run" : read.source === "poll" ? "a store check" : "the store's answer";

  return ` (read from ${where}${read.readAt ? ` at ${read.readAt}` : ""}${read.storeWord ? `, the store says ${read.storeWord}` : ""})`;
}

function storeVersionOf(raw: unknown): SubmissionView["storeVersion"] | undefined {
  if (!isPlainObject(raw)) return undefined;

  const packaged = str(raw.packaged);
  const displayed = str(raw.displayed);
  const source = str(raw.source);
  if (!packaged || !displayed || !source) return undefined;

  const buildNumber = typeof raw.buildNumber === "number" && Number.isInteger(raw.buildNumber) && raw.buildNumber > 0 ? raw.buildNumber : undefined;

  return { packaged, displayed, source, ...(buildNumber ? { buildNumber } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

function releaseTypeOfRow(appStoreRelease: unknown, publish: Record<string, unknown> | null): string | undefined {
  const polled = appStoreRelease && typeof appStoreRelease === "object" ? (appStoreRelease as Record<string, unknown>) : null;
  const known = (type: string | undefined) => (type && RELEASE_MODE_WORDS[type] ? type : undefined);
  const polledType = known(polled ? str(polled.type)?.toUpperCase() : undefined);
  const actType = known(publish ? str(publish.releaseType)?.toUpperCase() : undefined);
  const polledAt = Date.parse(String(polled?.readAt ?? ""));
  const actAt = Date.parse(String(publish?.at ?? ""));

  if (polledType && actType) return actAt > polledAt ? actType : polledType;

  return polledType ?? actType;
}

function submissionView(row: Record<string, unknown>): SubmissionView {
  const view: SubmissionView = {};
  const storeVersion = storeVersionOf(row.storeVersion);
  const version = storeVersion?.packaged || storeVersion?.displayed || str(row.version);
  const status = str(row.status);
  const storeUrl = str(row.storeUrl);
  const submittedAt = str(row.submittedAt) || str(row.timestamp);
  const channel = str(row.channel);
  const buildSha = str(row.buildSha) || str(row.buildId);
  const storeSubmissionId = str(row.storeSubmissionId);
  const publish = row.publish && typeof row.publish === "object" ? (row.publish as Record<string, unknown>) : null;
  const refusal = publish && str(publish.status) === "failed" ? str(publish.storeMessage) : undefined;
  const failureReason = str(row.failureReason) || refusal;
  const supersededBy = status === "superseded" ? str(row.supersededBy) : undefined;
  const storeCrxVersion = typeof row.storeCrxVersion === "string" ? row.storeCrxVersion.trim() : "";
  const storeReview = storeReviewOfRow(row.storeReview);
  const statusRead = statusReadOf(row.statusRead);
  const signed = amoUnlistedSigning(str(row.store), storeReview);
  const releaseType = releaseTypeOfRow(row.appStoreRelease, publish);
  if (releaseType) view.releaseType = releaseType;
  if (version) view.version = version;
  if (statusRead) view.statusRead = statusRead;
  if (status) view.status = signed ? AMO_SIGNED_STATUS : status;
  if (storeUrl) view.storeUrl = storeUrl;
  if (submittedAt) view.submittedAt = submittedAt;
  if (channel) view.channel = channel;
  if (buildSha) view.buildSha = buildSha;
  if (storeSubmissionId) view.storeSubmissionId = storeSubmissionId;
  if (failureReason) view.failureReason = failureReason;
  if (supersededBy) view.supersededBy = supersededBy;
  if (storeVersion) view.storeVersion = storeVersion;
  if (storeCrxVersion) view.storeCrxVersion = storeCrxVersion;
  if (storeReview) view.storeReview = storeReview;

  return view;
}

export function latestSubmissionsByStore(
  json: unknown,
): Record<string, SubmissionView> {
  const list = (json as { submissions?: unknown[] } | null)?.submissions;
  const out: Record<string, { at: number; view: SubmissionView }> = {};

  for (const raw of Array.isArray(list) ? list : []) {
    if (!isPlainObject(raw)) continue;

    const store = str(raw.store);
    if (!store) continue;

    const at = Date.parse(String(raw.submittedAt || raw.updatedAt || ""));
    const stamp = Number.isFinite(at) ? at : 0;

    if (!out[store] || stamp >= out[store].at) {
      out[store] = { at: stamp, view: submissionView(raw) };
    }
  }

  const flat: Record<string, SubmissionView> = {};
  for (const [store, entry] of Object.entries(out)) flat[store] = entry.view;

  return flat;
}

export function firefoxReleasesByChannel(rows: StoreReleaseView[]): Record<string, StoreReleaseView> | null {
  const lanes = newestStoreReleaseByLane(rows.filter((row) => row.store === "firefox" && row.amoChannel));
  const byChannel = Object.fromEntries(Object.values(lanes).map((row) => [row.amoChannel as string, row]));

  return Object.keys(byChannel).length ? byChannel : null;
}

export interface PollLaneView {
  ran: boolean;
  reason?: string;
  checked?: number;
  updated?: number;
  errors?: number;
  versionsRead?: number;
  versionsUnread?: string;
}

export interface NormalizedStoresStatus {
  lastSubmission?: Record<string, unknown>;
  lastOverride?: Record<string, unknown>;
  reviews: Record<string, ReviewView>;
  lastPollAt?: string;
  lanes: Record<string, PollLaneView>;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function pollLanesOf(raw: unknown): Record<string, PollLaneView> {
  const out: Record<string, PollLaneView> = {};
  if (!isPlainObject(raw)) return out;

  for (const [store, lane] of Object.entries(raw)) {
    if (!isPlainObject(lane) || typeof lane.ran !== "boolean") continue;

    const view: PollLaneView = { ran: lane.ran };
    const reason = str(lane.reason);
    const versionsUnread = str(lane.versionsUnread);
    if (reason) view.reason = reason;

    for (const key of ["checked", "updated", "errors", "versionsRead"] as const) {
      const value = count(lane[key]);
      if (value !== undefined) view[key] = value;
    }

    if (versionsUnread) view.versionsUnread = versionsUnread;

    out[store] = view;
  }

  return out;
}

export function pollLaneSentence(store: string, lane: PollLaneView | undefined, at: string | undefined): string {
  if (!lane) return "";

  const when = at ? ` at ${at}` : "";

  if (!lane.ran) return `the last store check${when} did not run the ${store} lane: ${lane.reason || "no reason recorded"}`;

  const read =
    store === "firefox" && lane.versionsRead !== undefined
      ? `, read ${lane.versionsRead} AMO version${lane.versionsRead === 1 ? "" : "s"}`
      : "";
  const wrote = lane.updated ? `wrote ${lane.updated} record${lane.updated === 1 ? "" : "s"}` : "wrote nothing";
  const unread = lane.versionsUnread ? `; ${lane.versionsUnread}, so no record took AMO's channel` : "";

  return `the last store check${when} checked ${lane.checked ?? 0} ${store} record${lane.checked === 1 ? "" : "s"}${read} and ${wrote}${unread}`;
}

export function normalizeStoresStatus(json: unknown): NormalizedStoresStatus {
  const base = isPlainObject(json) ? json : {};
  const out: NormalizedStoresStatus = { reviews: {}, lanes: {} };

  if (isPlainObject(base.lastSubmission)) out.lastSubmission = base.lastSubmission;
  if (isPlainObject(base.lastOverride)) out.lastOverride = base.lastOverride;

  if (isPlainObject(base.reviews)) {
    for (const [store, raw] of Object.entries(base.reviews)) {
      if (!isPlainObject(raw)) continue;

      out.reviews[store] = {
        status: str(raw.status),
        version: str(raw.version),
        buildId: str(raw.buildId),
        checkedAt: str(raw.checkedAt),
      };
    }
  }

  const lastPoll = isPlainObject(base.lastPoll) ? base.lastPoll : null;
  const looksLikeLegacyPoll =
    !lastPoll && (base.kind === "store_status" || Array.isArray(base.updates));

  if (lastPoll) {
    out.lastPollAt = str(lastPoll.timestamp);
    out.lanes = pollLanesOf(lastPoll.lanes);
  } else if (looksLikeLegacyPoll) {
    out.lastPollAt = str(base.updatedAt);

    for (const raw of Array.isArray(base.updates) ? base.updates : []) {
      if (!isPlainObject(raw)) continue;

      const store = str(raw.store);
      if (!store || out.reviews[store]) continue;

      out.reviews[store] = {
        status: str(raw.status),
        version: str(raw.version),
        buildId: str(raw.buildId),
        checkedAt: str(base.updatedAt),
      };
    }
  }

  return out;
}

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
  extra?: Record<string, unknown>,
): string {
  return envelope({
    ok: false,
    command: "extension_release_status",
    status,
    value: extra ?? {},
    error: { code, name, message },
  });
}

function healthReadAtNote(doc: unknown): string {
  const at = String((doc as { updatedAt?: unknown } | null)?.updatedAt ?? "").trim();

  return at ? ` (as of ${at})` : " (the health reading carries no date)";
}

export function contradictoryRef(args: { workspace?: string; project?: string }): string | null {
  const workspace = String(args.workspace ?? "").trim();
  const project = String(args.project ?? "").trim();
  if (!workspace || !project.includes("/")) return null;

  const named = project.split("/")[0] ?? "";
  if (named.toLowerCase() === workspace.toLowerCase()) return null;

  return `workspace '${workspace}' and project '${project}' name different workspaces; pass one of them, or project as '<workspace>/<project>' alone.`;
}

export interface RefreshWaitView {
  landed: boolean;
  waitedSeconds: number;
  stores: string[];
}

function refreshSentence(refresh: Record<string, StoreRefreshView> | null, wait: RefreshWaitView | null): string {
  if (!refresh || !Object.keys(refresh).length) return "";

  const reads: string[] = [];
  const rows = Object.entries(refresh).map(([store, row]) => {
    const word = row.dispatched
      ? "dispatched"
      : row.queued
        ? "queued for the budget reset"
        : row.storeRead
          ? "read now"
          : `refused: ${row.message || "no reason given"}`;
    const read = row.storeRead;

    if (read?.state === "live") {
      reads.push(
        `Edge Add-ons serves version ${read.version || read.manifestVersion || "unknown"}${
          read.manifestVersion && read.manifestVersion !== read.version ? ` (${read.manifestVersion})` : ""
        } now${read.listingUrl ? ` at ${read.listingUrl}` : ""}, and the platform recorded it before this read`,
      );
    } else if (read?.state === "absent") {
      reads.push("Edge Add-ons does not list the product yet");
    } else if (read?.state === "unresolved" || read?.state === "unreadable") {
      reads.push(`Edge Add-ons was not read: ${read.reason || "no reason given"}`);
    }

    return `${store} ${word}`;
  });

  const asked = `A store check was asked for (${rows.join("; ")})${reads.length ? `. ${reads.join(". ")}` : ""}`;

  if (wait?.landed) {
    return `${asked}; it landed within ${wait.waitedSeconds} s of waiting, so this read carries the state the check read for ${wait.stores.join(", ")}. `;
  }

  if (wait) {
    return `${asked}; it had not landed after ${wait.waitedSeconds} s of waiting, so this read is the state before it: read extension_release_status again before saying the state changed. `;
  }

  return `${asked}; the registry reflects the rest of the check within a minute or two, so read extension_release_status again before saying the state changed, or pass waitSeconds with refresh to answer once it lands. `;
}

const POLL_RECHECK_MS = 10_000;

function stampOf(at: unknown): number {
  const ms = Date.parse(String(at ?? ""));

  return Number.isFinite(ms) ? ms : Number.NaN;
}

function pollSince(refresh: Record<string, StoreRefreshView> | null, askedAt: number): { since: number; stores: string[] } | null {
  const dispatched = Object.entries(refresh ?? {}).filter(([, row]) => row.dispatched);
  if (!dispatched.length) return null;

  const stamps = dispatched.map(([, row]) => stampOf(row.dispatchedAt)).filter((ms) => Number.isFinite(ms));

  return { since: stamps.length ? Math.min(...stamps) : askedAt, stores: dispatched.map(([store]) => store) };
}

export function pollLanded(
  read: { rows: Array<Record<string, unknown>>; lastPollAt?: string },
  since: number,
  stores: string[],
): boolean {
  const polledSince = stampOf(read.lastPollAt) >= since;

  return stores.every((store) => {
    const row = read.rows.find((entry) => entry.store === store);
    const submission = row?.lastSubmission as SubmissionView | undefined;

    return (polledSince && Boolean(row?.lastPollLane)) || stampOf(submission?.statusRead?.readAt) >= since;
  });
}

function lookupSentence(lookup: SubmissionLookup | null, id: string): string {
  if (!lookup) return "";
  if (!lookup.found) return `Submission ${id} was not read: ${lookup.reason}. `;

  const entry = lookup.submission;
  const version = entry.storeVersion?.packaged || entry.version || "";
  const build = entry.storeVersion?.buildNumber ? ` build ${entry.storeVersion.buildNumber}` : "";
  const word = entry.statusWord || entry.status || "recorded";
  const review = entry.storeReview?.state ? `, the store says ${entry.storeReview.state}` : "";
  const channel = entry.amoChannel ? `, AMO channel ${entry.amoChannel}` : "";

  return `Submission ${entry.id ?? id} (${lookup.store}${version ? ` ${version}` : ""}${build}) reads ${word}${review}${channel}${
    entry.statusReadAt ? `, read at ${entry.statusReadAt}` : ""
  }. `;
}

export async function readStores(args: {
  workspace?: string;
  project?: string;
  api?: string;
  refresh?: string[];
  submissionId?: string;
  waitSeconds?: unknown;
}): Promise<string> {
  const ref = resolveProjectRef(args);

  if (!ref) {
    return fail(
      "StoreStatusInputError",
      contradictoryRef(args) ??
        "No project to inspect. Run extension_auth (action: login), which names the project, or pass workspace + project explicitly.",
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  const named = Boolean(args.workspace || args.project);
  const askedAt = outcomeClock.now();
  const refresh =
    Array.isArray(args.refresh) && args.refresh.length
      ? await refreshStores({
          stores: args.refresh,
          project: named ? `${ref.workspace}/${ref.project}` : undefined,
          api: args.api,
        })
      : null;
  const polled = args.waitSeconds !== undefined ? pollSince(refresh, askedAt) : null;
  const boundMs = polled ? waitBound(args.waitSeconds) * 1000 : 0;

  for (;;) {
    const read = await answerStores(args, ref, named, refresh);
    if (typeof read === "string" || !polled) return typeof read === "string" ? read : read.render(null);

    const elapsed = outcomeClock.now() - askedAt;
    const landed = pollLanded(read, polled.since, polled.stores);

    if (landed || elapsed >= boundMs) {
      return read.render({ landed, waitedSeconds: Math.round(elapsed / 1000), stores: polled.stores });
    }

    await outcomeClock.sleep(Math.min(POLL_RECHECK_MS, boundMs - elapsed));
  }
}

interface StoresRead {
  rows: Array<Record<string, unknown>>;
  lastPollAt?: string;
  render: (wait: RefreshWaitView | null) => string;
}

async function answerStores(
  args: { api?: string; submissionId?: string },
  ref: ProjectRef,
  named: boolean,
  refresh: Record<string, StoreRefreshView> | null,
): Promise<string | StoresRead> {
  const healthUrl = registryFileUrl(ref, "stores/health.json", args.api);
  const statusUrl = registryFileUrl(ref, "stores/status.json", args.api);
  const submissionsUrl = registryFileUrl(ref, "stores/submissions.json", args.api);
  const consoleStoresUrl = consoleProjectUrl(
    ref,
    ConsoleProjectPage.submissions,
    args.api,
  );

  const [healthRes, statusRes, submissionsRes, platform, records, releases] = await Promise.all([
    fetchRegistryJson(healthUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(statusUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(submissionsUrl, fetch, { ref, api: args.api }),
    readPlatformSubmissions({ ref, named, api: args.api }),
    readPlatformStoreRecords({ ref, named, api: args.api, stores: KNOWN_STORES }),
    readPlatformStoreReleases({ ref, named, api: args.api }),
  ]);
  const wantedId = String(args.submissionId ?? "").trim();
  const lookup: SubmissionLookup | null = wantedId
    ? (records.ok ? findStoreSubmission(records.history, wantedId) : null) ??
      (records.ok || !records.skipped
        ? await readStoreSubmissionById({ ref, named, api: args.api, stores: KNOWN_STORES, id: wantedId })
        : { found: false, reason: "reading one submission by id needs a stored login for this project (extension_auth)" })
    : null;
  const releaseByStore: Record<string, StoreReleaseView> = releases.ok
    ? newestStoreReleaseByStore(releases.rows)
    : {};

  const heldRead = [healthRes, statusRes, submissionsRes].find(
    (res) => !res.ok && res.held === true,
  );

  const heldRecords = !records.ok && !records.skipped && records.held ? records : null;

  if ((heldRead && !heldRead.ok) || heldRecords) {
    return platformHoldEnvelope({
      command: "extension_release_status",
      name: "StoreStatusHeld",
      body: heldRead && !heldRead.ok ? heldRead.body : heldRecords?.body,
      api: args.api,
      value: { workspace: ref.workspace, project: ref.project },
    });
  }

  if (!healthRes.ok && !statusRes.ok && !submissionsRes.ok && !platform.ok && !records.ok) {
    return fail(
      "StoreStatusNotFound",
      `No store data on the registry for ${ref.workspace}/${ref.project} (${healthRes.message}). The project may have no stores configured yet, be private (private registry data is read with a stored login for this project, which extension_auth mints), or the workspace/project slugs may be wrong. Configure stores at ${consoleStoresUrl}/new; the console Submissions page is the authoritative view: ${consoleStoresUrl}`,
      "unavailable",
      "E_PLATFORM",
      {
        workspace: ref.workspace,
        project: ref.project,
        registryUrls: { health: healthUrl, status: statusUrl, submissions: submissionsUrl },
        consoleStoresUrl,
      },
    );
  }

  const healthStores: Record<string, HealthRow> | null = healthRes.ok
    ? isPlainObject((healthRes.json as { stores?: unknown })?.stores)
      ? ((healthRes.json as { stores: Record<string, HealthRow> }).stores ?? null)
      : null
    : null;
  const status = normalizeStoresStatus(statusRes.ok ? statusRes.json : null);
  const submissionsByStore = submissionsRes.ok
    ? latestSubmissionsByStore(submissionsRes.json)
    : {};

  const statusLastStore = str(status.lastSubmission?.store);

  if (statusLastStore && !submissionsByStore[statusLastStore] && status.lastSubmission) {
    submissionsByStore[statusLastStore] = submissionView(status.lastSubmission);
  }

  const runsByStore: Record<string, SubmissionRun> = {};

  for (const [store, latest] of Object.entries(platform.ok ? platform.byStore : {})) {
    if (!isNewerOrSame(latest.submittedAt, submissionsByStore[store]?.submittedAt)) continue;

    const { run, store: _store, appStoreRelease, ...rest } = latest;
    const releaseType = releaseTypeOfRow(appStoreRelease, (rest.publish as Record<string, unknown> | undefined) ?? null);
    const typed = releaseType ? { ...rest, releaseType } : rest;
    const fields = amoUnlistedSigning(store, typed.storeReview) ? { ...typed, status: AMO_SIGNED_STATUS } : typed;
    submissionsByStore[store] = fields.storeVersion ? { ...fields, version: fields.storeVersion.packaged } : fields;
    if (Object.keys(run).length > 0) runsByStore[store] = run;
  }

  const stores = [
    ...KNOWN_STORES,
    ...Object.keys({ ...healthStores, ...submissionsByStore, ...status.reviews }).filter(
      (s) => !(KNOWN_STORES as readonly string[]).includes(s),
    ),
  ];

  const configs = records.ok ? records.config : null;

  const rows = stores.map((store) => {
    const healthRow = healthStores?.[store];
    const config = configs?.[store];
    const configured: boolean | "unknown" = healthStores
      ? Boolean(healthRow)
      : config
        ? config.configured
        : "unknown";
    const row: Record<string, unknown> = { store, configured };

    if (config) row.config = config;

    if (healthRow) {
      row.health = {
        ok: healthRow.ok === true,
        checkedAt: str(healthRow.checkedAt),
        message: str(healthRow.message),
      };
    }

    const submission = submissionsByStore[store];

    if (submission && store === "edge") {
      const repaired = repairEdgeStoreUrl(submission.storeUrl, config?.storeUrl);

      if (repaired) submission.storeUrl = repaired;
      else delete submission.storeUrl;
    }

    if (submission && Object.keys(submission).length > 0) {
      row.lastSubmission = submission;
    }

    if (runsByStore[store]) row.submissionRun = runsByStore[store];
    if (releaseByStore[store]) row.release = releaseByStore[store];

    const liveRelease = releases.ok ? liveStoreReleaseOf(releases.rows, store) : undefined;
    if (liveRelease && liveRelease !== releaseByStore[store]) row.liveRelease = liveRelease;

    const amoChannels = store === "firefox" && releases.ok ? firefoxReleasesByChannel(releases.rows) : null;
    if (amoChannels) row.amoChannels = amoChannels;

    const earlier = (records.ok
      ? earlierSubmissions(records.history[store] ?? [], submissionsByStore[store])
      : []
    ).map((entry) => {
      if (store !== "edge" || !entry.storeUrl) return entry;

      const repaired = repairEdgeStoreUrl(entry.storeUrl, config?.storeUrl);
      const { storeUrl: _dead, ...rest } = entry;

      return repaired ? { ...rest, storeUrl: repaired } : rest;
    });
    if (earlier.length > 0) row.submissionHistory = earlier;

    const recorded = records.ok ? (records.history[store] ?? []).length : 0;
    if (recorded > earlier.length + (submissionsByStore[store] ? 1 : 0)) row.submissionCount = recorded;

    const lane = status.lanes[store];
    if (lane) row.lastPollLane = lane;

    const review = storeReviewLine({
      store,
      row: status.reviews[store],
      latest: submissionsByStore[store],
      earlier,
    });

    if (review && Object.values(review).some(Boolean)) {
      row.review = review;
    }

    const queuedAct = platform.ok ? platform.queued[store] : undefined;
    if (queuedAct) row.queuedAct = queuedAct;

    const step = store === "safari" ? safariNextStep(submission, consoleStoresUrl) : null;
    if (step) row.nextStep = step;

    return row;
  });

  const healthAbsent = !healthRes.ok && healthRes.status === 404;
  const submissionsKnown = submissionsRes.ok || submissionsRes.status === 404;

  const summaryParts = rows.map((row) => {
    const store = String(row.store);
    const health = row.health as { ok: boolean; message?: string } | undefined;
    const submission = row.lastSubmission as SubmissionView | undefined;
    const review = row.review as ReviewView | undefined;
    const config = row.config as { credentialsConfigured: boolean; missingCredentials: string[] } | undefined;
    let head: string;

    if (row.configured === "unknown") {
      head = `${store}: configuration unknown (${healthAbsent ? "no store health record yet" : "stores/health.json is unreadable"})`;
    } else if (row.configured === false) {
      head = `${store}: not configured (add it at ${consoleStoresUrl}/new)`;
    } else if (!health) {
      head = `${store}: configured, no credential health check recorded`;
    } else if (!health.ok) {
      head = `${store}: configured but its credentials FAILED the last health check (${
        health.message || "no reason recorded"
      }) - fix them at ${consoleStoresUrl}/${store}`;
    } else {
      head = `${store}: configured, credentials healthy${healthReadAtNote(healthRes.ok ? healthRes.json : null)}`;
    }

    const tail: string[] = [];

    if (row.configured !== false && config && !config.credentialsConfigured && config.missingCredentials.length > 0) {
      tail.push(`credentials not set: ${config.missingCredentials.join(", ")}`);
    }

    if (submission) {
      tail.push(
        `last submission${submission.version ? ` v${submission.version}` : ""} ${
          submission.status || "recorded"
        }${statusReadNote(submission.statusRead)}${submission.submittedAt ? ` at ${submission.submittedAt}` : ""}${
          submission.failureReason ? ` (${submission.failureReason})` : ""
        }${submission.supersededBy ? ` (replaced by ${submission.supersededBy} before review, not rejected)` : ""}`,
      );

      if (submission.storeUrl) tail.push(`listing ${submission.storeUrl}`);

      const run = row.submissionRun as SubmissionRun | undefined;
      const reason = submission.failureReason;
      const runNote =
        reason && run?.message?.startsWith(reason)
          ? run.message.slice(reason.length).trim()
          : run?.message;
      if (runNote) tail.push(runNote);

      const retry = retryNote(submission, runNote);
      if (retry) tail.push(retry);
    } else if (row.configured === true) {
      tail.push(
        submissionsKnown || (records.ok && records.history[store])
          ? "no submissions recorded"
          : "submissions unknown: stores/submissions.json could not be read",
      );
    }

    if (review?.status) tail.push(reviewSentence(review));

    const laneSentence = pollLaneSentence(store, row.lastPollLane as PollLaneView | undefined, status.lastPollAt);
    if (laneSentence && row.configured !== false) tail.push(laneSentence);

    if (typeof row.submissionCount === "number") {
      tail.push(
        `${row.submissionCount} submissions recorded, the newest ${((row.submissionHistory as unknown[] | undefined)?.length ?? 0) + 1} shown; read any one with submissionId`,
      );
    }

    if (store === "safari") {
      const withdrawal = safariWithdrawalSentence(submission, (row.submissionHistory as StoreHistoryEntry[] | undefined) ?? []);
      if (withdrawal) tail.push(withdrawal);

      const releaseMode = safariReleaseSentence(submission);
      if (releaseMode) tail.push(releaseMode);

      const releaseStep = safariReleaseStepSentence(submission);
      if (releaseStep) tail.push(releaseStep);
    }

    const release = row.release as StoreReleaseView | undefined;
    const channelReleases = row.amoChannels ? Object.values(row.amoChannels as Record<string, StoreReleaseView>) : [];

    if (channelReleases.length) tail.push(...channelReleases.map((entry) => `release: ${storeReleaseSentence(entry)}`));
    else if (release) tail.push(`release: ${storeReleaseSentence(release)}`);

    const queuedAct = row.queuedAct as QueuedStoreActView | undefined;

    if (queuedAct) {
      tail.push(`${queuedAct.act} of build ${queuedAct.buildSha || "unknown"} ${queuedActSentence(queuedAct)}; it sends on its own once ${queuedAct.clearsWhen}`);
    }

    return tail.length > 0 ? `${head}; ${tail.join("; ")}` : head;
  });

  const healthUnavailable = healthRes.ok ? null : storeRecordUnread("health", healthRes, `both start from the console Submissions page: ${consoleStoresUrl}`);
  const statusUnavailable = statusRes.ok ? null : storeRecordUnread("status", statusRes, "extension_submit runs one");
  const platformUnavailable =
    !platform.ok && !platform.skipped
      ? `the platform's submission records could not be read, so a run that ended before recording its outcome is not reflected: ${platform.message}`
      : null;
  const recordsUnavailable = records.ok
    ? [
        records.configMessage ? `the platform's store configuration could not be read: ${records.configMessage}` : null,
        records.historyUnread.length
          ? `earlier submissions could not be read for ${records.historyUnread.join("; ")}`
          : null,
      ]
    : records.skipped
      ? []
      : [`the platform's store configuration and submission history could not be read: ${records.message}`];
  const submissionsUnavailable =
    !submissionsRes.ok && submissionsRes.status !== 404
      ? `stores/submissions.json unreadable: ${submissionsRes.message}`
      : null;
  const releasesUnavailable = releases.ok
    ? releases.unread
      ? "the platform could not read the store releases, so each store's release is unknown, not empty"
      : null
    : releases.skipped
      ? null
      : `the store releases could not be read from the platform: ${releases.message}`;

  const render = (wait: RefreshWaitView | null): string => envelope({
    ok: true,
    command: "extension_release_status",
    status: "read",
    value: {
      workspace: ref.workspace,
      project: ref.project,
      stores: rows,
      ...(status.lastSubmission
        ? { lastSubmission: status.lastSubmission }
        : {}),
      ...(status.lastPollAt ? { lastPollAt: status.lastPollAt } : {}),
      ...(refresh ? { refresh } : {}),
      ...(wait ? { refreshWait: wait } : {}),
      ...(lookup ? { submission: lookup } : {}),
      registryUrls: {
        health: healthUrl,
        status: statusUrl,
        submissions: submissionsUrl,
      },
      consoleStoresUrl,
    },
    hint: `${refreshSentence(refresh, wait)}${lookupSentence(lookup, wantedId)}${summaryParts.join(". ")}. This is the registry's recorded state (submissions and the review poller write it)${
      platform.ok ? ", with the platform's own submission records and their runs" : ""
    }; the store dashboards are authoritative and may be ahead of it.`,
    warnings: [
      healthUnavailable,
      statusUnavailable,
      submissionsUnavailable,
      platformUnavailable,
      releasesUnavailable,
      ...recordsUnavailable,
    ],
  });

  return { rows, ...(status.lastPollAt ? { lastPollAt: status.lastPollAt } : {}), render };
}
