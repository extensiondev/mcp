// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { repairEdgeStoreUrl } from "./edge-listing";
import { openProjectApi, projectApiGet } from "./project-api";
import { storeReviewOfRow } from "./review-beside-submission";

import type { StoreReview } from "./platform-submissions";

const HISTORY_PER_STORE = 5;

const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface StoreConfigView {
  enabled: boolean;
  configured: boolean;
  credentialsConfigured: boolean;
  missingCredentials: string[];
  credentialsUnverified?: true;
  storeUrl?: string;
  storeId?: string;
  bundleId?: string;
  releaseChannel?: string;
  submissionMode?: string;
}

export interface StoreHistoryEntry {
  id?: string;
  status?: string;
  version?: string;
  channel?: string;
  buildSha?: string;
  submittedAt?: string;
  failureReason?: string;
  supersededBy?: string;
  storeUrl?: string;
  storeVersion?: { packaged: string; buildNumber?: number };
  storeReview?: StoreReview;
  statusReadAt?: string;
  statusWord?: string;
  amoChannel?: "listed" | "unlisted";
}

export type PlatformStoreRecords =
  | {
      ok: true;
      config: Record<string, StoreConfigView> | null;
      configMessage?: string;
      history: Record<string, StoreHistoryEntry[]>;
      historyUnread: string[];
    }
  | { ok: false; skipped: true }
  | { ok: false; skipped: false; held: boolean; body?: unknown; message: string };

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

  return text || undefined;
}

/* @invariant THE CONFIGURATION IS COPIED BY NAME, NEVER SPREAD. The platform's
 * store configuration answer carries listing data and could one day carry a
 * credential, so only the fields named here leave this function, and a missing
 * credential is reported by its variable name alone, never by a value.
 */
export function storeConfigView(raw: unknown, store?: string): StoreConfigView | null {
  if (!isRow(raw)) return null;

  const view: StoreConfigView = {
    enabled: raw.enabled === true,
    configured: raw.configured === true,
    credentialsConfigured: raw.credentialsConfigured === true,
    missingCredentials: (Array.isArray(raw.missingSecrets) ? raw.missingSecrets : [])
      .map((name) => String(name ?? "").trim())
      .filter((name) => CREDENTIAL_NAME.test(name)),
  };

  if (raw.credentialsVerified === false) view.credentialsUnverified = true;

  for (const key of ["storeUrl", "storeId", "bundleId", "releaseChannel"] as const) {
    const value = str(raw[key]);
    if (value) view[key] = value;
  }

  if (store === "edge" && view.storeUrl) {
    const listing = repairEdgeStoreUrl(view.storeUrl, raw.crxId);

    if (listing) view.storeUrl = listing;
    else delete view.storeUrl;
  }

  const mode = isRow(raw.submissionMode) ? str(raw.submissionMode.id) : str(raw.submissionMode);
  if (mode) view.submissionMode = mode;

  return view;
}

function amoChannelOf(raw: Row): StoreHistoryEntry["amoChannel"] {
  const review = isRow(raw.storeReview) ? str(raw.storeReview.visibility)?.toLowerCase() : undefined;
  const sent = str(raw.amoChannel)?.toLowerCase();

  for (const channel of [review, sent]) {
    if (channel === "listed" || channel === "unlisted") return channel;
  }

  return undefined;
}

export function historyEntry(raw: Row): StoreHistoryEntry {
  const entry: StoreHistoryEntry = {};
  const fields: Array<[keyof StoreHistoryEntry, unknown]> = [
    ["id", raw.id],
    ["status", raw.status],
    ["version", raw.version],
    ["channel", raw.channel],
    ["buildSha", raw.buildId],
    ["submittedAt", raw.submittedAt],
    ["failureReason", raw.failureReason],
    ["supersededBy", raw.supersededBy],
    ["storeUrl", raw.storeUrl],
  ];

  for (const [key, value] of fields) {
    const text = str(value);
    if (text) (entry as Record<string, unknown>)[key] = text;
  }

  const packaged = isRow(raw.storeVersion) ? str(raw.storeVersion.packaged) : "";
  const buildNumber = isRow(raw.storeVersion) ? Number(raw.storeVersion.buildNumber) : 0;
  const storeReview = storeReviewOfRow(raw.storeReview);
  const statusReadAt = isRow(raw.statusRead) ? str(raw.statusRead.readAt) : "";
  const statusWord = isRow(raw.statusRead) ? str(raw.statusRead.word) : "";
  const amoChannel = amoChannelOf(raw);

  if (packaged) {
    entry.storeVersion = {
      packaged,
      ...(Number.isInteger(buildNumber) && buildNumber > 0 ? { buildNumber } : {}),
    };
  }

  if (storeReview) entry.storeReview = storeReview;
  if (statusReadAt) entry.statusReadAt = statusReadAt;
  if (statusWord) entry.statusWord = statusWord;
  if (amoChannel) entry.amoChannel = amoChannel;

  return entry;
}

export type SubmissionLookup =
  | { found: true; store: string; submission: StoreHistoryEntry }
  | { found: false; reason: string };

const SHORT_ID = 8;

export function findStoreSubmission(history: Record<string, StoreHistoryEntry[]>, id: string): SubmissionLookup | null {
  const wanted = id.trim().toLowerCase();
  if (!wanted) return { found: false, reason: "no submission id was given" };

  const matches = Object.entries(history).flatMap(([store, entries]) =>
    entries
      .filter((entry) => {
        const own = String(entry.id ?? "").toLowerCase();

        return own === wanted || (wanted.length >= SHORT_ID && own.startsWith(wanted));
      })
      .map((submission) => ({ store, submission })),
  );

  if (matches.length === 1) return { found: true, ...matches[0]! };

  if (matches.length > 1) {
    return { found: false, reason: `${matches.length} submissions start with ${id}; pass more of the id` };
  }

  return null;
}

export async function readStoreSubmissionById(args: {
  ref: { workspace: string; project: string };
  named: boolean;
  api?: string;
  stores: readonly string[];
  id: string;
}): Promise<SubmissionLookup> {
  const opened = await openProjectApi({
    command: "extension_release_status",
    project: args.named ? `${args.ref.workspace}/${args.ref.project}` : undefined,
    api: args.api,
    expect: args.ref,
  });

  if (!opened.ok) return { found: false, reason: opened.message };

  const unread: string[] = [];

  for (const store of args.stores) {
    const read = await projectApiGet<Row>(
      opened.api,
      `stores/${encodeURIComponent(store)}/submissions/${encodeURIComponent(args.id.trim())}`,
    );

    if (read.ok && isRow(read.json)) return { found: true, store, submission: historyEntry(read.json) };
    if (!read.ok && read.status !== 404) unread.push(`${store}: ${read.message}`);
  }

  return {
    found: false,
    reason: unread.length
      ? `no store answered submission ${args.id} (${unread.join("; ")})`
      : `no store holds a submission with id ${args.id}`,
  };
}

export function earlierSubmissions(
  entries: StoreHistoryEntry[],
  latest: { id?: string; submittedAt?: string; version?: string } | undefined,
): StoreHistoryEntry[] {
  const sorted = [...entries].sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")));
  const isLatest = (entry: StoreHistoryEntry): boolean =>
    Boolean(latest?.id && entry.id === latest.id) ||
    (entry.submittedAt === latest?.submittedAt && entry.version === latest?.version);
  const rest = latest ? sorted.filter((entry) => !isLatest(entry)) : sorted;

  return rest.slice(0, HISTORY_PER_STORE);
}

export async function readPlatformStoreRecords(args: {
  ref: { workspace: string; project: string };
  named: boolean;
  api?: string;
  stores: readonly string[];
}): Promise<PlatformStoreRecords> {
  const opened = await openProjectApi({
    command: "extension_release_status",
    project: args.named ? `${args.ref.workspace}/${args.ref.project}` : undefined,
    api: args.api,
    expect: args.ref,
  });

  if (!opened.ok) {
    if (opened.reason === "no-login" || opened.reason === "other-project") return { ok: false, skipped: true };

    return { ok: false, skipped: false, held: opened.reason === "held", body: opened.body, message: opened.message };
  }

  const [config, ...lists] = await Promise.all([
    projectApiGet<Row>(opened.api, "stores/config"),
    ...args.stores.map((store) => projectApiGet<unknown[]>(opened.api, `stores/${encodeURIComponent(store)}/submissions`)),
  ]);

  const held = [config, ...lists].find((read) => !read.ok && read.held);

  if (held && !held.ok) return { ok: false, skipped: false, held: true, body: held.body, message: held.message };

  const history: Record<string, StoreHistoryEntry[]> = {};
  const historyUnread: string[] = [];

  args.stores.forEach((store, i) => {
    const read = lists[i];

    if (!read.ok) {
      historyUnread.push(`${store}: ${read.message}`);

      return;
    }

    history[store] = (Array.isArray(read.json) ? read.json : []).filter(isRow).map(historyEntry);
  });

  let views: Record<string, StoreConfigView> | null = null;

  if (config.ok) {
    views = {};

    for (const store of args.stores) {
      const view = storeConfigView(config.json[store], store);
      if (view) views[store] = view;
    }
  }

  return {
    ok: true,
    config: views,
    ...(config.ok ? {} : { configMessage: config.message }),
    history,
    historyUnread,
  };
}
