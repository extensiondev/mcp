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
  reviewBesideSubmission,
  reviewSentence,
  storeReviewOfRow,
  type ReviewView,
} from "../lib/review-beside-submission";
import {
  earlierSubmissions,
  readPlatformStoreRecords,
} from "../lib/platform-store-records";
import { repairEdgeStoreUrl } from "../lib/edge-listing";
import { storeRecordUnread } from "../lib/store-readiness";
import { openProjectApi, projectApiSend } from "../lib/project-api";
import {
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
  if (version) view.version = version;
  if (statusRead) view.statusRead = statusRead;
  if (status) view.status = status;
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

export interface NormalizedStoresStatus {
  lastSubmission?: Record<string, unknown>;
  lastOverride?: Record<string, unknown>;
  reviews: Record<string, ReviewView>;
  lastPollAt?: string;
}

export function normalizeStoresStatus(json: unknown): NormalizedStoresStatus {
  const base = isPlainObject(json) ? json : {};
  const out: NormalizedStoresStatus = { reviews: {} };

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

function refreshSentence(refresh: Record<string, StoreRefreshView> | null): string {
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

  return `A store check was asked for (${rows.join("; ")})${reads.length ? `. ${reads.join(". ")}` : ""}; the registry reflects the rest of the check within a minute or two, so read extension_release_status again before saying the state changed. `;
}

export async function readStores(args: {
  workspace?: string;
  project?: string;
  api?: string;
  refresh?: string[];
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

  const healthUrl = registryFileUrl(ref, "stores/health.json", args.api);
  const statusUrl = registryFileUrl(ref, "stores/status.json", args.api);
  const submissionsUrl = registryFileUrl(ref, "stores/submissions.json", args.api);
  const consoleStoresUrl = consoleProjectUrl(
    ref,
    ConsoleProjectPage.submissions,
    args.api,
  );

  const named = Boolean(args.workspace || args.project);
  const refresh =
    Array.isArray(args.refresh) && args.refresh.length
      ? await refreshStores({
          stores: args.refresh,
          project: named ? `${ref.workspace}/${ref.project}` : undefined,
          api: args.api,
        })
      : null;
  const [healthRes, statusRes, submissionsRes, platform, records, releases] = await Promise.all([
    fetchRegistryJson(healthUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(statusUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(submissionsUrl, fetch, { ref, api: args.api }),
    readPlatformSubmissions({ ref, named, api: args.api }),
    readPlatformStoreRecords({ ref, named, api: args.api, stores: KNOWN_STORES }),
    readPlatformStoreReleases({ ref, named, api: args.api }),
  ]);
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

    const { run, store: _store, ...fields } = latest;
    submissionsByStore[store] = fields;
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

    const review = reviewBesideSubmission(status.reviews[store], submissionsByStore[store]);

    if (review && Object.values(review).some(Boolean)) {
      row.review = review;
    }

    const queuedAct = platform.ok ? platform.queued[store] : undefined;
    if (queuedAct) row.queuedAct = queuedAct;

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

    const release = row.release as StoreReleaseView | undefined;
    if (release) tail.push(`release: ${storeReleaseSentence(release)}`);

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

  return envelope({
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
      registryUrls: {
        health: healthUrl,
        status: statusUrl,
        submissions: submissionsUrl,
      },
      consoleStoresUrl,
    },
    hint: `${refreshSentence(refresh)}${summaryParts.join(". ")}. This is the registry's recorded state (submissions and the review poller write it)${
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
}
