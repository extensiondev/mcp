// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ApprovalScope } from "./approval-verify";

export const VERSION_ACTION = "extension_submit.version";

export type LineState =
  | "pending"
  | "spent"
  | "queued"
  | "refunded"
  | "denied"
  | "revoked"
  | "consumed"
  | "not-in-approval"
  | "unspent";

export interface ApprovalLineRow {
  id: string;
  store: string;
  act: string;
  state: LineState;
  line?: string;
  lock?: string;
  message?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const STATES = new Set<string>([
  "pending",
  "spent",
  "queued",
  "refunded",
  "denied",
  "revoked",
  "consumed",
  "not-in-approval",
  "unspent",
]);

export const lineId = (store: string, act = "upload"): string => `${store}:${act}`;

/* @invariant ONE VERSION, ONE APPROVAL, ONE LINE PER STORE. A real submit
 * naming several stores asks the platform for a version grant whose scope
 * is the build, the version label the call carries (an empty string when
 * none) and one "<store>:upload" line per store, hashed the way the platform
 * hashes it; a single-store submit keeps the single act. The platform spends
 * each line on its own, so a retry after a refund names only the stores that
 * did not run and the grant still covers them.
 */
export function versionScope(browsers: string[], buildSha: string, version: unknown): ApprovalScope {
  return versionScopeFor(browsers.map((store) => ({ store, act: "upload" })), buildSha, version);
}

/* @invariant A PUBLISH LINE BINDS THE BUILD, A LISTING LINE BINDS ITS TEXT.
 * The scope the platform hashes is the build, the version label and one
 * "<store>:<act>" per line; a listing line adds "<store>:<digest>" under
 * listings, the same digest the single listing grant hashes, so the owner's
 * one approval covers the exact words each store receives and nothing else.
 */
export function versionScopeFor(
  lines: Array<{ store: string; act: string }>,
  buildSha: string,
  version: unknown,
  listings: Record<string, string> = {},
): ApprovalScope {
  const digests = Object.entries(listings)
    .filter(([, digest]) => text(digest))
    .map(([store, digest]) => `${store}:${text(digest).toLowerCase()}`)
    .sort();

  return {
    acts: [...new Set(lines.map((line) => lineId(line.store, line.act)))].sort(),
    buildSha: text(buildSha).toLowerCase(),
    ...(digests.length ? { listings: digests } : {}),
    version: text(version),
  };
}

function lockText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const lock = value as Record<string, unknown>;
  const clears = text(lock.clearsWhen);

  return clears ? `queued until ${clears}` : "";
}

export function readLines(raw: unknown): ApprovalLineRow[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];

    const item = row as Record<string, unknown>;
    const store = text(item.store);
    const act = text(item.act) || "upload";
    const state = text(item.state);

    if (!store || !STATES.has(state)) return [];

    return [
      {
        id: text(item.id) || lineId(store, act),
        store,
        act,
        state: state as LineState,
        ...(text(item.line) ? { line: text(item.line) } : {}),
        ...(lockText(item.lock) ? { lock: lockText(item.lock) } : {}),
        ...(text(item.message) ? { message: text(item.message) } : {}),
      },
    ];
  });
}

export function storesInState(lines: ApprovalLineRow[], ...states: LineState[]): string[] {
  return lines.filter((line) => states.includes(line.state)).map((line) => line.store);
}

const WORDS: Record<LineState, string> = {
  pending: "not run yet",
  spent: "ran",
  queued: "queued behind the store's review, its line still pending",
  refunded: "given back, nothing ran",
  denied: "left out by the owner",
  revoked: "revoked",
  consumed: "already ran on an earlier call",
  "not-in-approval": "not in this approval",
  unspent: "not reached, still covered",
};

export function linesSentence(lines: ApprovalLineRow[]): string {
  return lines.map((line) => `${line.store}: ${WORDS[line.state]}`).join("; ");
}

export function retryStores(lines: ApprovalLineRow[]): string[] {
  return storesInState(lines, "refunded", "unspent", "pending");
}
