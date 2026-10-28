// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { repairEdgeStoreUrl } from "./edge-listing";
import { openProjectApi, projectApiGet } from "./project-api";

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

function historyEntry(raw: Row): StoreHistoryEntry {
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
    if (text) entry[key] = text;
  }

  return entry;
}

export function earlierSubmissions(
  entries: StoreHistoryEntry[],
  latest: { submittedAt?: string; version?: string } | undefined,
): StoreHistoryEntry[] {
  const sorted = [...entries].sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")));
  const rest = latest
    ? sorted.filter((entry) => !(entry.submittedAt === latest.submittedAt && entry.version === latest.version))
    : sorted;

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
