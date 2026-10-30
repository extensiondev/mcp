// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openProjectApi, projectApiGet } from "./project-api";

export const STORE_RELEASE_STATES = ["uploaded", "in-review", "approved", "live", "rejected", "withdrawn", "superseded"] as const;

export type StoreReleaseState = (typeof STORE_RELEASE_STATES)[number] | "unknown";

const KNOWN_STORE_WORD_SOURCES: ReadonlySet<string> = new Set(["publish-answer", "poll", "run", "inferred", "hand"]);

export interface StoreReleaseView {
  id: string;
  store: string;
  browser: string;
  version: string;
  buildSha: string;
  state: StoreReleaseState;
  stateWord?: string;
  storeWord: string;
  readAt: string;
  source: string;
  visibility?: string;
  storeVersion?: { packaged: string; displayed: string; source: string; buildNumber?: number };
  submissionId: string;
  submittedAt: string;
  updatedAt: string;
  storeUrl?: string;
  failureReason?: string;
  channel?: string;
  amoChannel?: string;
  supersededBy?: string;
  releaseType?: string;
  releaseTypeReadAt?: string;
}

export interface StoreReleasesSummary {
  activeReleases?: number;
  liveChannels?: number;
  channels?: number;
  describes?: { activeReleases?: string; liveChannels?: string };
}

export type PlatformStoreReleases =
  | { ok: true; rows: StoreReleaseView[]; unread: boolean; summary: StoreReleasesSummary }
  | { ok: false; skipped: true }
  | { ok: false; skipped: false; held: boolean; body?: unknown; message: string };

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* @invariant A STORE RELEASE ROW IS COPIED BY NAME AND CARRIES THE STORE'S
 * WORD AS THE PLATFORM READ IT. Decision A (Cezar, 2026-10-28): a store
 * submission is the release of that build for that browser, and decision B
 * makes every state name where its word was read and when; a row whose
 * source is inferred is relayed as such and grounds no next step.
 */
export function storeReleaseView(raw: unknown): StoreReleaseView | null {
  if (!isRow(raw)) return null;

  const state = str(raw.state);
  const id = str(raw.id);
  const store = str(raw.store);
  if (!id || !store || !state) return null;

  const known = (STORE_RELEASE_STATES as readonly string[]).includes(state);

  const view: StoreReleaseView = {
    id,
    store,
    browser: str(raw.browser) || store,
    version: str(raw.version),
    buildSha: str(raw.buildSha),
    state: known ? (state as StoreReleaseState) : "unknown",
    ...(known ? {} : { stateWord: state }),
    storeWord: str(raw.storeWord),
    readAt: str(raw.readAt),
    source: str(raw.source) || "inferred",
    submissionId: str(raw.submissionId),
    submittedAt: str(raw.submittedAt),
    updatedAt: str(raw.updatedAt),
  };

  for (const key of ["visibility", "storeUrl", "failureReason", "channel", "amoChannel", "supersededBy", "releaseType", "releaseTypeReadAt"] as const) {
    const value = str(raw[key]);
    if (value) view[key] = value;
  }

  if (isRow(raw.storeVersion)) {
    const packaged = str(raw.storeVersion.packaged);
    const displayed = str(raw.storeVersion.displayed);
    const buildNumber = count(raw.storeVersion.buildNumber);

    if (packaged) {
      view.storeVersion = {
        packaged,
        displayed: displayed || packaged,
        source: str(raw.storeVersion.source) || "platform",
        ...(buildNumber ? { buildNumber } : {}),
      };
    }
  }

  return view;
}

export function storeReleasesOf(json: unknown): { rows: StoreReleaseView[]; unread: boolean; summary: StoreReleasesSummary } {
  const body = isRow(json) ? json : {};
  const rows = (Array.isArray(body.storeReleases) ? body.storeReleases : [])
    .map(storeReleaseView)
    .filter((row): row is StoreReleaseView => Boolean(row));
  const summary = isRow(body.summary) ? body.summary : {};

  return {
    rows,
    unread: body.storeReleasesUnread === true,
    summary: {
      activeReleases: count(summary.activeReleases),
      liveChannels: count(summary.liveChannels),
      channels: count(summary.channels),
      ...(isRow(summary.describes)
        ? {
            describes: {
              activeReleases: str(summary.describes.activeReleases) || undefined,
              liveChannels: str(summary.describes.liveChannels) || undefined,
            },
          }
        : {}),
    },
  };
}

export function liveStoreReleaseOf(rows: StoreReleaseView[], store: string): StoreReleaseView | undefined {
  return rows.find((row) => row.store === store && row.state === "live");
}

const RELEASE_MODE_WORDS: Record<string, string> = {
  AFTER_APPROVAL: "set to release automatically after approval",
  MANUAL: "set to manual release",
  SCHEDULED: "set to a scheduled release",
};

export function newestStoreReleaseByStore(rows: StoreReleaseView[]): Record<string, StoreReleaseView> {
  const out: Record<string, StoreReleaseView> = {};

  for (const row of rows) {
    if (!out[row.store]) out[row.store] = row;
  }

  return out;
}

/* @invariant FIREFOX IS READ ONE LINE PER AMO CHANNEL. AMO keeps the newest
 * listed version in review and the newest unlisted version signed side by
 * side (Rebeccat 2026-10-29: 0.2.0.7 listed and unreviewed, 0.2.0.8 unlisted
 * and signed), so the store read answers the newest row of each channel and
 * an unlisted upload never hides the listed version's review.
 */
export function storeReleaseLane(row: Pick<StoreReleaseView, "store" | "amoChannel">): string {
  return row.store === "firefox" && row.amoChannel ? `firefox ${row.amoChannel}` : row.store;
}

export function newestStoreReleaseByLane(rows: StoreReleaseView[]): Record<string, StoreReleaseView> {
  const out: Record<string, StoreReleaseView> = {};

  for (const row of rows) {
    const lane = storeReleaseLane(row);
    if (!out[lane]) out[lane] = row;
  }

  return out;
}

export function storeReleaseSentence(row: StoreReleaseView): string {
  const version =
    row.storeVersion?.buildNumber && row.storeVersion.displayed === row.version
      ? `${row.version} (build ${row.storeVersion.buildNumber})`
      : row.version;
  const read =
    row.source === "inferred"
      ? "inferred from the platform's record, no store word read"
      : row.source === "hand"
        ? `recorded by hand from the store's own dashboard ${row.readAt || "at an unknown time"}, not read by a store check`
        : KNOWN_STORE_WORD_SOURCES.has(row.source)
          ? `the store's word ${row.storeWord || "unknown"}, read ${row.readAt || "at an unknown time"} by ${row.source}`
          : `the store's word ${row.storeWord || "unknown"}, read ${row.readAt || "at an unknown time"} by ${row.source}, a source this MCP does not know, so it grounds no next step`;
  const state = row.state === "unknown" ? `${row.stateWord || "unknown"} (a state this MCP does not know; update the MCP to read it)` : row.state;
  const audience =
    row.state === "live"
      ? row.visibility
        ? `, ${row.visibility}`
        : ", audience not read"
      : "";

  const mode = row.releaseType ? RELEASE_MODE_WORDS[row.releaseType] : undefined;
  const release = mode
    ? `, ${mode} as App Store Connect answered ${row.releaseTypeReadAt || "at an unknown time"}`
    : row.store === "safari"
      ? ", release mode not read yet"
      : "";

  const waiting =
    row.state === "approved" && row.source !== "inferred" && row.storeWord === "PENDING_DEVELOPER_RELEASE"
      ? `, waiting for your release with extension_submit {action: "release", browsers: ["${row.store}"]}`
      : "";

  return `${storeReleaseLane(row)} ${version} ${state}${audience}${release}${waiting} on build ${row.buildSha || "unknown"} (${read})`;
}

export function storeReleasesSentence(rows: StoreReleaseView[], unread: boolean): string {
  if (unread) return "The store releases could not be read from the platform, so what is live in each store is unknown, not empty.";

  const newest = Object.values(newestStoreReleaseByLane(rows));
  if (!newest.length) return "No store has received a release of this project yet.";

  const live = Object.values(newestStoreReleaseByLane(rows.filter((row) => row.state === "live")));
  const rest = newest.filter((row) => row.state !== "live");
  const parts: string[] = [];

  if (live.length) parts.push(`Live in ${live.length === 1 ? "one store" : `${live.length} stores`}: ${live.map(storeReleaseSentence).join("; ")}.`);
  if (rest.length) parts.push(`${live.length ? "Not live yet" : "In the stores"}: ${rest.map(storeReleaseSentence).join("; ")}.`);
  if (!live.length) parts.push("Nothing is live in a store.");

  return parts.join(" ");
}

export async function readPlatformStoreReleases(args: {
  ref: { workspace: string; project: string };
  named: boolean;
  api?: string;
}): Promise<PlatformStoreReleases> {
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

  const read = await projectApiGet<Row>(opened.api, "releases");

  if (!read.ok) return { ok: false, skipped: false, held: read.held, body: read.body, message: read.message };

  return { ok: true, ...storeReleasesOf(read.json) };
}
