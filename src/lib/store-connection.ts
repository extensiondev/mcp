// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "./console-urls";
import { envelope, isEnvelope } from "./envelope";
import { isRow, text } from "./ship-act";

import type { ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const REVIEW_PROMISE = "Nothing goes to review until you publish.";
export const ITEM_ON_FIRST_SUBMISSION = "The Chrome Web Store item is created on the first submission.";
export const NOT_CONNECTED_CODES = new Set(["STORE_NOT_CONNECTED", "STORE_CONNECTION_UNHEALTHY"]);

const CHROME_DASHBOARD = "https://chrome.google.com/webstore/devconsole";

export interface StoreConnection {
  kind: string | null;
  connectedAs: string | null;
  healthy: boolean | null;
  itemId: string | null;
  reason?: string;
  itemUrl?: string;
}

export function connectSentences(connectUrl: string): string {
  return `Connect your Chrome Web Store account once at ${connectUrl}; Google asks for one click. Then I submit it as an unlisted draft, and nothing goes to review until you publish.`;
}

export function failedCheckSentence(reason: string): string {
  const said = reason.replace(/[.\s]+$/, "") || "no reason was recorded";

  return `Your Chrome Web Store connection failed its last check: ${said}.`;
}

export function storeSettingsUrl(ref: ProjectRef | null, api?: string): string {
  return consoleProjectUrl(ref, ConsoleProjectPage.projectSettingsSection("stores"), api);
}

export function fallbackConnectUrl(ref: ProjectRef | null, store: string, api?: string): string {
  return `${storeSettingsUrl(ref, api)}?connect=${encodeURIComponent(store)}`;
}

export function chromeItemUrl(row: Row): string {
  const given = text(row.itemUrl) || text(row.dashboardUrl);
  if (given) return given;

  const itemId = text(row.itemId);
  if (!itemId) return "";

  const publisherId = text(row.publisherId);

  return publisherId
    ? `${CHROME_DASHBOARD}/${encodeURIComponent(publisherId)}/${encodeURIComponent(itemId)}/edit`
    : CHROME_DASHBOARD;
}

export function connectionOf(json: Row): (StoreConnection & { connectUrl?: string }) | null {
  if (!isRow(json.connection)) return null;

  const row = json.connection;
  const kind = text(row.kind) || null;
  const reason = text(row.reason) || text(row.message) || text(row.lastCheckMessage);
  const itemUrl = chromeItemUrl(row);
  const connectUrl = text(json.connectUrl) || text(row.connectUrl);

  return {
    kind,
    connectedAs: text(row.connectedAs) || null,
    healthy: typeof row.healthy === "boolean" ? row.healthy : null,
    itemId: text(row.itemId) || null,
    ...(reason ? { reason } : {}),
    ...(itemUrl ? { itemUrl } : {}),
    ...(connectUrl ? { connectUrl } : {}),
  };
}

const SECRET_NAME =
  /\b(?:STORE_(?:CHROME|EDGE|FIREFOX|AMO|SAFARI)_[A-Z0-9_]+|(?:CHROME|EDGE|FIREFOX|AMO|SAFARI|APPLE|ASC|CWS)_[A-Z0-9_]*?(?:CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|API_KEY|API_SECRET|SERVICE_ACCOUNT_JSON|SERVICE_ACCOUNT_SECRET|PUBLISHER_ID|ISSUER_ID|KEY_ID|PASSWORD|BASE64|SECRET|TOKEN))\b/g;

const SECRET_LIST = new RegExp(`${SECRET_NAME.source}(?:(?:,\\s*(?:and\\s+|or\\s+)?|\\s+(?:and|or)\\s+)${SECRET_NAME.source})+`, "g");

function opensSentence(offset: number, whole: string): boolean {
  const before = whole.slice(Math.max(0, offset - 2), offset);

  return offset === 0 || before.endsWith("\"") || /[.!?]\s$/.test(before);
}

export function withoutSecretNames(value: string): string {
  return value
    .replace(SECRET_LIST, (_list, offset: number, whole: string) => (opensSentence(offset, whole) ? "Store credentials" : "store credentials"))
    .replace(SECRET_NAME, (_name, offset: number, whole: string) => (opensSentence(offset, whole) ? "A store credential" : "a store credential"));
}

export function withReviewPromise(out: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed) || parsed.status !== "approval-required") return out;

  const value = isRow(parsed.value) ? parsed.value : {};
  const expiresAt = text(value.expiresAt);
  const closing = [expiresAt ? `The approval expires at ${expiresAt}.` : "", REVIEW_PROMISE].filter(Boolean).join(" ");
  const hint = text(parsed.hint);

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, ...(expiresAt ? { expiresAt } : {}), reviewPromise: REVIEW_PROMISE },
    error: parsed.error ? { ...parsed.error, message: `${parsed.error.message} ${closing}` } : null,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    hint: hint ? `${hint} ${closing}` : closing,
  });
}
