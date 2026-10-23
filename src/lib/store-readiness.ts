// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { projectApiSend } from "./project-api";
import { fetchRegistryJson, registryFileUrl, type ProjectRef, type RegistryFetchRefusal } from "./registry";
import { firefoxKeyPairFailedSentences } from "./firefox-store";
import { isRow, openShipApi, text } from "./ship-act";
import {
  connectSentences,
  connectionOf,
  failedCheckSentence,
  fallbackConnectUrl,
  itemLinkUrls,
  linkItemSentences,
  nextStep,
  storeSettingsUrl,
  submitStep,
  type NextStep,
  type StoreConnection,
} from "./store-connection";

type Row = Record<string, unknown>;

export const NOT_CHECKED = "not checked";

export type StoreState =
  | "ready"
  | "store-not-connected"
  | "store-connection-failed"
  | "store-item-not-linked"
  | "store-not-configured"
  | "store-unhealthy"
  | "not-checked";

export type Verdict = StoreState | "platform-refused";

export type ConnectionRecord = StoreConnection & { connectUrl?: string; newItemUrl?: string; packageUrl?: string; linkItemUrl?: string };

export interface StoreRow {
  browser: string;
  ok: boolean;
  state: StoreState;
  configured: boolean | typeof NOT_CHECKED;
  healthy?: boolean | typeof NOT_CHECKED;
  itemLinked?: boolean;
  itemUrl?: string;
  connectedAs?: string;
  source: "connection" | "health" | "none";
  publishMode: typeof NOT_CHECKED;
  reason?: string;
}

interface Context {
  ref: ProjectRef | null;
  api?: string;
}

const CONNECTION_STATES = new Set<StoreState>(["store-not-connected", "store-connection-failed", "store-item-not-linked"]);

export function isConnectionState(state: string): boolean {
  return CONNECTION_STATES.has(state as StoreState);
}

export type StoreSubmissionMode = { id: string; label: string; description: string };

export function submissionModeOf(json: Row): StoreSubmissionMode | null {
  const mode = isRow(json.submissionMode) ? json.submissionMode : null;
  if (!mode || !text(mode.id)) return null;

  return { id: text(mode.id), label: text(mode.label), description: text(mode.description) };
}

export async function readConnectionsAndModes(
  args: { project?: string; api?: string; buildSha?: string; channel?: string },
  browsers: string[],
): Promise<{ connections: Record<string, ConnectionRecord>; modes: Record<string, StoreSubmissionMode>; reports: Record<string, Row> }> {
  const opened = await openShipApi("extension_submit", args, { action: "submit" }).catch(() => null);
  if (!opened || "refused" in opened) return { connections: {}, modes: {}, reports: {} };

  const body: Row = {};
  if (text(args.buildSha)) body.buildId = text(args.buildSha);
  if (text(args.channel)) body.channel = text(args.channel);

  const reads = await Promise.all(
    browsers.map((browser) => projectApiSend<Row>(opened.api, "POST", `stores/${browser}/submissions/preflight`, body).catch(() => null)),
  );
  const connections: Record<string, ConnectionRecord> = {};
  const modes: Record<string, StoreSubmissionMode> = {};
  const reports: Record<string, Row> = {};

  browsers.forEach((browser, i) => {
    const read = reads[i];
    if (!read || !read.ok || !isRow(read.json)) return;

    reports[browser] = read.json;

    const connection = connectionOf(read.json);
    if (connection) connections[browser] = connection;

    const mode = submissionModeOf(read.json);
    if (mode) modes[browser] = mode;
  });

  return { connections, modes, reports };
}

export async function readConnections(
  args: { project?: string; api?: string; buildSha?: string; channel?: string },
  browsers: string[],
): Promise<Record<string, ConnectionRecord>> {
  return (await readConnectionsAndModes(args, browsers)).connections;
}

export type HealthRead = { stores: Record<string, { ok?: boolean; message?: string }> } | { missing: string };

export const STORE_RECORD_ABSENT = {
  health: "the project has no store health record yet; the platform writes it on the first store health probe (a store connect or a credential recheck triggers one)",
  status: "the project has no store status record yet; it is written at the end of the first submission",
} as const;

export function storeRecordUnread(file: keyof typeof STORE_RECORD_ABSENT, read: RegistryFetchRefusal, next?: string): string {
  if (read.status !== 404) return `stores/${file}.json unreadable: ${read.message}`;

  return next ? `${STORE_RECORD_ABSENT[file]}; ${next}` : STORE_RECORD_ABSENT[file];
}

export async function readLegacyHealth(ctx: Context): Promise<HealthRead> {
  if (!ctx.ref) return { missing: "no stored login names the project (run extension_auth)" };

  const read = await fetchRegistryJson(registryFileUrl(ctx.ref, "stores/health.json", ctx.api), fetch, { ref: ctx.ref, api: ctx.api });

  if (!read.ok) return { missing: read.status === 404 ? STORE_RECORD_ABSENT.health : "the store health record could not be read" };

  const stores = isRow(read.json) ? read.json.stores : undefined;

  return isRow(stores) ? { stores: stores as Record<string, { ok?: boolean; message?: string }> } : { missing: "the store health record lists no stores" };
}

export function rowFromConnection(browser: string, connection: ConnectionRecord): StoreRow {
  const base = { browser, source: "connection" as const, publishMode: NOT_CHECKED as typeof NOT_CHECKED };
  const who = connection.connectedAs ? { connectedAs: connection.connectedAs } : {};

  if (!connection.kind) {
    return { ...base, ok: false, state: "store-not-connected", configured: false, reason: `No ${browser} store account is connected to this project.` };
  }

  if (connection.healthy === false) {
    return { ...base, ...who, ok: false, state: "store-connection-failed", configured: true, healthy: false, reason: failedCheckSentence(connection.reason ?? "", browser) };
  }

  if (connection.healthy !== true) {
    return { ...base, ...who, ok: false, state: "not-checked", configured: true, healthy: NOT_CHECKED, reason: `The ${browser} store is connected and its connection has not been checked yet.` };
  }

  if (connection.itemLinked === false) {
    return { ...base, ...who, ok: false, state: "store-item-not-linked", configured: true, healthy: true, itemLinked: false, reason: `The ${browser} store is connected and healthy, and no store item is linked to this project yet.` };
  }

  return {
    ...base,
    ...who,
    ok: true,
    state: "ready",
    configured: true,
    healthy: true,
    ...(connection.itemLinked === true || connection.itemId ? { itemLinked: true } : {}),
    ...(connection.itemUrl ? { itemUrl: connection.itemUrl } : {}),
  };
}

export function rowFromHealth(browser: string, health: HealthRead): StoreRow {
  const base = { browser, source: "health" as const, publishMode: NOT_CHECKED as typeof NOT_CHECKED };

  if ("missing" in health) {
    return { ...base, source: "none", ok: false, state: "not-checked", configured: NOT_CHECKED, healthy: NOT_CHECKED, reason: `The ${browser} store was not checked: ${health.missing}.` };
  }

  const row = health.stores[browser];

  if (!row) {
    return { ...base, ok: false, state: "store-not-configured", configured: false, reason: `No ${browser} store is configured on this project.` };
  }

  if (row.ok !== true) {
    return { ...base, ok: false, state: "store-unhealthy", configured: true, healthy: false, reason: text(row.message) || `The ${browser} store is configured but failed its last credential health check.` };
  }

  return { ...base, ok: true, state: "ready", configured: true, healthy: true };
}

export async function readStoreRows(
  args: { project?: string; api?: string; buildSha?: string; channel?: string },
  browsers: string[],
  ctx: Context,
): Promise<{ rows: StoreRow[]; connections: Record<string, ConnectionRecord> }> {
  const connections = await readConnections(args, browsers);
  const needsHealth = browsers.some((browser) => !connections[browser]);
  const health = needsHealth ? await readLegacyHealth(ctx) : null;
  const rows = browsers.map((browser) => (connections[browser] ? rowFromConnection(browser, connections[browser]) : rowFromHealth(browser, health as HealthRead)));

  return { rows, connections };
}

export function connectionStep(row: StoreRow, connection: ConnectionRecord | undefined, ctx: Context): NextStep {
  const settingsUrl = storeSettingsUrl(ctx.ref, ctx.api);

  if (row.state === "store-item-not-linked") {
    const urls = itemLinkUrls([connection ?? {}], settingsUrl);

    return nextStep("link-item", linkItemSentences(urls), urls.linkItemUrl);
  }

  const connectUrl = connection?.connectUrl || fallbackConnectUrl(ctx.ref, row.browser, ctx.api);

  if (row.browser === "firefox" && row.state === "store-connection-failed") {
    const say = firefoxKeyPairFailedSentences(connection?.reason ?? "", connectUrl);

    return nextStep("connect", say, connectUrl);
  }

  if (row.browser !== "chrome") {
    const say = `${row.reason ?? ""} Set up the ${row.browser} store once at ${connectUrl}; then I submit it after one owner approval.`.trim();

    return nextStep("connect", say, connectUrl);
  }

  if (row.state === "store-connection-failed" || row.state === "store-unhealthy") {
    return nextStep("connect", `${row.state === "store-unhealthy" ? failedCheckSentence(row.reason ?? "") : row.reason} ${connectSentences(connectUrl)}`, connectUrl);
  }

  return nextStep("connect", connectSentences(connectUrl), connectUrl);
}

function storeList(browsers: string[]): string {
  return browsers.length > 1 ? `${browsers.slice(0, -1).join(", ")} and ${browsers[browsers.length - 1]}` : browsers[0] ?? "";
}

export interface DryRunVerdict {
  verdict: Verdict;
  ok: boolean;
  nextStep: NextStep | null;
  trackUrl: string;
  say: string;
}

export function dryRunVerdict(
  rows: StoreRow[],
  platform: { ok: boolean; message: string },
  connections: Record<string, ConnectionRecord>,
  ctx: Context & { storePageUrl: string },
): DryRunVerdict {
  const browsers = rows.map((row) => row.browser);

  if (!platform.ok) {
    return {
      verdict: "platform-refused",
      ok: false,
      nextStep: null,
      trackUrl: ctx.storePageUrl,
      say: `Not ready: the platform refused this dry run${platform.message ? `: ${platform.message.replace(/[.\s]+$/, "")}` : ""}.`,
    };
  }

  const blocked = rows.find((row) => row.state !== "ready" && row.state !== "not-checked");

  if (blocked) {
    const step = connectionStep(blocked, connections[blocked.browser], ctx);
    const trackUrl = blocked.state === "store-item-not-linked" || isConnectionState(blocked.state) || blocked.source === "health" ? storeSettingsUrl(ctx.ref, ctx.api) : ctx.storePageUrl;

    return { verdict: blocked.state, ok: false, nextStep: step, trackUrl, say: `Not ready for ${blocked.browser}: ${step.say}` };
  }

  const unchecked = rows.filter((row) => row.state === "not-checked").map((row) => row.browser);

  if (unchecked.length) {
    const say = `The platform dry run passed; ${storeList(unchecked)} ${unchecked.length > 1 ? "were" : "was"} not checked here. A real submission checks each store's connection first and, if one is not ready, says what to fix before anything is sent.`;

    return { verdict: "not-checked", ok: true, nextStep: nextStep("submit", say), trackUrl: ctx.storePageUrl, say };
  }

  const step = submitStep(browsers);

  return { verdict: "ready", ok: true, nextStep: step, trackUrl: ctx.storePageUrl, say: `Ready: ${step.say}` };
}
