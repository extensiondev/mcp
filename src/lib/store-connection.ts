// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { approvalSubjectPhrase, subjectOf } from "./approval-subject";
import { consoleProjectUrl } from "./console-urls";
import { envelope, isEnvelope } from "./envelope";
import { isRow, text } from "./ship-act";

import type { ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const REVIEW_PROMISE = "Nothing goes to review until you publish.";
export const NOT_CONNECTED_CODES = new Set(["STORE_NOT_CONNECTED", "STORE_CONNECTION_UNHEALTHY"]);
export const ITEM_NOT_LINKED_CODE = "STORE_ITEM_NOT_LINKED";

const CHROME_DASHBOARD = "https://chrome.google.com/webstore/devconsole";

export interface StoreConnection {
  kind: string | null;
  connectedAs: string | null;
  healthy: boolean | null;
  itemId: string | null;
  itemLinked?: boolean;
  reason?: string;
  itemUrl?: string;
}

export interface ItemLinkUrls {
  newItemUrl: string;
  packageUrl: string;
  linkItemUrl: string;
}

export type NextStepKind = "connect" | "link-item" | "submit" | "approve" | "publish" | "resubmit" | "done";

export interface NextStep {
  kind: NextStepKind;
  say: string;
  url: string | null;
}

const DRAFT_STORES = new Set(["chrome", "edge"]);

export function nextStep(kind: NextStepKind, say: string, url?: string): NextStep {
  return { kind, say, url: url || null };
}

const STORE_NAMES: Record<string, string> = {
  chrome: "the Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "the App Store",
};

function storeNames(stores: string[]): string {
  const names = stores.map((store) => STORE_NAMES[store] ?? store);

  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "the store";
}

/* @invariant THE SAVED MODE DECIDES, AND THE WORDS FOLLOW IT. Cezar ruled on
 * 2026-08-05 that a machine-lane upload stops at the safe outcome only where
 * the store config never stated a mode, and that an explicit mode is honored
 * whoever saved it. Chrome's draft-until-public and Edge's draft are the
 * unstated defaults, so an upload under them stays a draft; Chrome public or
 * staged and Edge review send the upload on to review. On 2026-10-21 the
 * approval said "for store review" beside "nothing goes to review", so every
 * sentence here now reads the mode first and says which of the two is true.
 */
const DRAFT_MODE_IDS: Record<string, ReadonlySet<string>> = {
  chrome: new Set(["draft-until-public"]),
  edge: new Set(["draft"]),
};

const DRAFT_MODE_LABELS: Record<string, string> = {
  chrome: "Draft until published",
  edge: "Draft only",
};

export type ModeIds = Record<string, string | undefined>;

export function uploadStopsAtDraft(store: string, modeId?: string | null): boolean {
  if (!DRAFT_STORES.has(store)) return false;

  const id = String(modeId || "").trim();

  return !id || (DRAFT_MODE_IDS[store]?.has(id) ?? false);
}

export function broadModeSentence(store: string, modeId: string): string {
  const name = STORE_NAMES[store] ?? store;

  return `Under ${name}'s saved mode "${modeId}" this upload goes on to review after it lands; to stop at a draft instead, set that mode to "${DRAFT_MODE_LABELS[store] ?? "draft"}" in the console store settings before approving.`;
}

export function reviewSentenceFor(stores: string[], modes: ModeIds = {}): string {
  const draftStores = stores.filter((store) => DRAFT_STORES.has(store));
  if (draftStores.length === 0) return "";

  const broad = draftStores.filter((store) => !uploadStopsAtDraft(store, modes[store]));
  if (broad.length === 0) return REVIEW_PROMISE;

  return broad.map((store) => broadModeSentence(store, String(modes[store]))).join(" ");
}

export function submitStep(stores: string[], modes: ModeIds = {}): NextStep {
  const drafts = stores.length > 0 && stores.every((store) => uploadStopsAtDraft(store, modes[store]));
  const broad = stores.filter((store) => DRAFT_STORES.has(store) && !uploadStopsAtDraft(store, modes[store]));

  return nextStep(
    "submit",
    drafts
      ? `Every check for ${storeNames(stores)} is green. I upload it as a store draft after one owner approval; a draft is not published and nothing goes to review until you publish. Whether the item is public or unlisted is set once in the store's own dashboard (a new Chrome item defaults to public), not by this upload.`
      : broad.length > 0
        ? `Every check for ${storeNames(stores)} is green. ${broad.map((store) => broadModeSentence(store, String(modes[store]))).join(" ")} I submit it after one owner approval.`
        : `Every check for ${storeNames(stores)} is green. I submit it after one owner approval.`,
  );
}

export const PUBLISH_SENTENCE = "To send it to review, say publish; that is one more approval.";

export const PUBLISH_APPROVAL_SENTENCE = "This sends the item to Chrome's review.";

export function doneStep(stores: string[], itemUrl: string): NextStep {
  const drafts = stores.length > 0 && stores.every((store) => DRAFT_STORES.has(store));
  const uploaded = `The build is uploaded to ${storeNames(stores)} as a draft, recorded as uploaded and not public.`;
  const testers =
    "A store draft cannot be installed from the store, but testers can already install this same build from its extension.dev build link (extension_publish shares it) while the store review has not run.";

  if (drafts && stores.includes("chrome")) {
    return nextStep("publish", `${uploaded} ${testers} ${PUBLISH_SENTENCE}`);
  }

  return nextStep(
    "done",
    drafts
      ? `${uploaded} To send it to review, save a publishing mode in the project's store settings on extension.dev; a chat act for that store is not available yet.`
      : `The platform recorded the submission for ${storeNames(stores)}; each store's own review comes after this.`,
    drafts ? undefined : itemUrl || undefined,
  );
}

export function withApproveStep(out: string, reviewSentence: boolean | string): string {
  const closing = reviewSentence === true ? REVIEW_PROMISE : reviewSentence === false ? "" : reviewSentence;
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed) || parsed.status !== "approval-required") return out;

  const value = isRow(parsed.value) ? parsed.value : {};
  const approvalUrl = text(value.approvalUrl);
  if (!approvalUrl) return out;

  const expiresAt = text(value.expiresAt);
  const phrase = approvalSubjectPhrase(subjectOf(value));
  const say = [
    `Approve ${phrase ? `submitting ${phrase}` : "the submission"} at ${approvalUrl}${expiresAt ? ` before ${expiresAt}` : ""}.`,
    closing,
  ]
    .filter(Boolean)
    .join(" ");

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, nextStep: nextStep("approve", say, approvalUrl) },
    error: parsed.error,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    ...(parsed.hint ? { hint: parsed.hint } : {}),
  });
}

export function linkItemSentences(urls: ItemLinkUrls): string {
  return `One step is yours, once: create the item in the Chrome Web Store dashboard at ${urls.newItemUrl} with this package ${urls.packageUrl}, and fill its Store listing and Privacy tabs there; your synced listing text is on the extension.dev store settings page to copy. Then paste the item's dashboard address at ${urls.linkItemUrl}. After that I upload every build as a draft that is not published, and nothing goes to review until you publish; set the item's visibility (public or unlisted) once in that dashboard, since no store API sets it.`;
}

export function itemLinkUrls(rows: unknown[], settingsUrl: string): ItemLinkUrls {
  const pick = (key: string) => rows.map((row) => (isRow(row) ? text(row[key]) : "")).find(Boolean) ?? "";

  return {
    newItemUrl: pick("newItemUrl") || CHROME_DASHBOARD,
    packageUrl: pick("packageUrl") || settingsUrl,
    linkItemUrl: pick("linkItemUrl") || `${settingsUrl}?connect=chrome`,
  };
}

export function connectSentences(connectUrl: string): string {
  return `Connect your Chrome Web Store account once at ${connectUrl}; Google asks for one click. Then I upload it as a draft that is not published, and nothing goes to review until you publish; the item's visibility (public or unlisted) is set once in the Chrome Web Store dashboard, since no store API sets it.`;
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

export function connectionOf(json: Row): (StoreConnection & Partial<ItemLinkUrls> & { connectUrl?: string }) | null {
  if (!isRow(json.connection)) return null;

  const row = json.connection;
  const kind = text(row.kind) || null;
  const reason = text(row.reason) || text(row.message) || text(row.lastCheckMessage);
  const itemUrl = chromeItemUrl(row);
  const connectUrl = text(json.connectUrl) || text(row.connectUrl);
  const links = ["newItemUrl", "packageUrl", "linkItemUrl"]
    .map((key) => [key, text(row[key]) || text(json[key])] as const)
    .filter(([, url]) => url);

  return {
    kind,
    connectedAs: text(row.connectedAs) || null,
    healthy: typeof row.healthy === "boolean" ? row.healthy : null,
    itemId: text(row.itemId) || null,
    ...(typeof row.itemLinked === "boolean" ? { itemLinked: row.itemLinked } : {}),
    ...Object.fromEntries(links),
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

export function withReviewPromise(out: string, reviewSentence: string = REVIEW_PROMISE): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed) || parsed.status !== "approval-required") return out;

  const value = isRow(parsed.value) ? parsed.value : {};
  const expiresAt = text(value.expiresAt);
  const closing = [expiresAt ? `The approval expires at ${expiresAt}.` : "", reviewSentence].filter(Boolean).join(" ");
  const hint = text(parsed.hint);

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, ...(expiresAt ? { expiresAt } : {}), reviewPromise: reviewSentence },
    error: parsed.error ? { ...parsed.error, message: `${parsed.error.message} ${closing}` } : null,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    hint: hint ? `${hint} ${closing}` : closing,
  });
}
