// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { loginMissing, openProjectApi, projectApiGet } from "./project-api";
import { spokenDate } from "./publish-link";
import { lockedSentence, readPushState, type OwedField, type PushState } from "./store-listing-push";

type Row = Record<string, unknown>;

export type ListingPushState = "queued" | "running" | "failed" | "landed" | "locked" | "unknown";

export interface ListingPushView {
  state: ListingPushState;
  dispatchedAt?: string;
  failedStep?: string;
  failedReason?: string;
  landedAt?: string;
  lockedVersion?: string;
  lockedState?: string;
  owed?: OwedField[];
  say: string;
}

export type ListingPushRead =
  | { ok: true; push: ListingPushView | null }
  | { ok: false; skipped: boolean; message: string };

const PUSH_LEAD = "The Safari listing push";

export const SAFARI_LISTING_RESEND = 'extension_submit {action: "sync-listing", browsers: ["safari"], projectPath}';

function stateOf(push: PushState): ListingPushState {
  if (push.runState && push.runState !== "unknown") return push.runState;
  if (push.status === "landed" || push.status === "locked") return push.status;
  if (push.status === "failed") return push.runState === "unknown" ? "unknown" : "failed";

  return push.runState ?? "unknown";
}

const at = (iso: string | undefined): string => (iso && Number.isFinite(Date.parse(iso)) ? ` dispatched ${spokenDate(iso)}` : "");

const unclosed = (line: string): string => line.replace(/[.\s]+$/, "");

function failedSentence(view: Omit<ListingPushView, "say">, head: string): string {
  const step = view.failedStep ? ` at step "${view.failedStep}"` : "";
  const why = view.failedReason ? `: ${unclosed(view.failedReason)}` : "";
  const refused = view.owed?.length
    ? `Apple refused ${view.owed.map((row) => (row.reason ? `${row.field} (${unclosed(row.reason)})` : row.field)).join("; ")}`
    : "";
  const reached = view.landedAt
    ? `Apple still holds the listing that landed ${spokenDate(view.landedAt)}`
    : refused || "Nothing reached App Store Connect";
  const extra = view.landedAt && refused ? `. ${refused}` : "";

  return `${head} failed${step}${why}. ${reached}${extra}; ${SAFARI_LISTING_RESEND} sends it again`;
}

function sentence(view: Omit<ListingPushView, "say">, message: string | undefined): string {
  const head = `${PUSH_LEAD}${at(view.dispatchedAt)}`;

  if (view.state === "failed") return failedSentence(view, head);

  if (view.state === "locked") return unclosed(message || lockedSentence(view));

  if (view.state === "queued" || view.state === "running") {
    return `${head} is ${view.state}; read the release status again in a minute for what landed`;
  }

  if (view.state === "landed") {
    return `${PUSH_LEAD} landed on App Store Connect${view.landedAt ? ` ${spokenDate(view.landedAt)}` : ""}`;
  }

  return `${head} has no outcome on record, so what reached App Store Connect is unknown; ${SAFARI_LISTING_RESEND} sends it again`;
}

export function listingPushView(push: PushState): ListingPushView {
  const view: Omit<ListingPushView, "say"> = { state: stateOf(push) };

  if (push.dispatchedAt) view.dispatchedAt = push.dispatchedAt;
  if (push.failedStep) view.failedStep = push.failedStep;
  if (push.failedReason) view.failedReason = push.failedReason;
  if (push.landedAt) view.landedAt = push.landedAt;
  if (push.lockedVersion) view.lockedVersion = push.lockedVersion;
  if (push.lockedState) view.lockedState = push.lockedState;
  if (push.owed?.length) view.owed = push.owed;

  return { ...view, say: sentence(view, view.state === "locked" ? push.reason : undefined) };
}

export function listingPushOpen(view: ListingPushView | null | undefined): boolean {
  return Boolean(view && (view.state === "failed" || view.state === "unknown"));
}

export async function readSafariListingPush(args: {
  ref: { workspace: string; project: string };
  named: boolean;
  api?: string;
  command: string;
}): Promise<ListingPushRead> {
  const opened = await openProjectApi({
    command: args.command,
    project: args.named ? `${args.ref.workspace}/${args.ref.project}` : undefined,
    api: args.api,
    expect: args.ref,
  });

  if (!opened.ok) {
    return { ok: false, skipped: loginMissing(opened) || opened.reason === "other-project", message: opened.message };
  }

  const read = await projectApiGet<Row>(opened.api, "stores/safari/listing", { push: 1 });

  if (!read.ok) return { ok: false, skipped: read.status === 404, message: read.message };

  const push = readPushState(read.json.appStoreConnect);

  return { ok: true, push: push ? listingPushView(push) : null };
}


export function openListingPushWarnings(section: Row | null): string[] {
  const warnings = section && Array.isArray(section.warnings) ? section.warnings : [];

  return warnings.filter((line): line is string => typeof line === "string" && line.startsWith(PUSH_LEAD));
}
