// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { projectApiSend, type ProjectApi, type ProjectApiRead } from "./project-api";
import { spokenDate } from "./publish-link";
import { isRow, text } from "./ship-act";
import { byHandFields, byHandSentence, STORE_ACT_NOT_ON_LANE_CODE } from "./store-act-by-hand";
import { STORE_MD_FILENAME } from "./store-md";

import type { ListingStore } from "./store-md-listing";

type Row = Record<string, unknown>;

const PUSH_STATUSES = ["dispatched", "failed", "unchanged", "landed", "locked"] as const;
const RUN_STATES = ["queued", "running", "failed", "landed", "locked", "unanswered", "unknown"] as const;

export type PushStatus = (typeof PUSH_STATUSES)[number];
export type RunState = (typeof RUN_STATES)[number];
export type Resend = "none" | "sent" | "refused";

export interface OwedField {
  field: string;
  reason: string;
}

export interface PushState {
  status: PushStatus;
  runState?: RunState;
  failedStep?: string;
  failedReason?: string;
  dispatchedAt?: string;
  retryHint?: string;
  reason?: string;
  code?: string;
  handPath?: string;
  handUrl?: string;
  notOnLane?: true;
  fieldsWritten?: number;
  checkedAt?: string;
  landedAt?: string;
  owed?: OwedField[];
  lockedVersion?: string;
  lockedState?: string;
  warnings?: string[];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const given = text(value);

  return (allowed as readonly string[]).includes(given) ? (given as T) : undefined;
}

function owedOf(value: unknown): OwedField[] {
  return (Array.isArray(value) ? value : [])
    .filter(isRow)
    .map((row) => ({ field: text(row.field), reason: text(row.reason) }))
    .filter((row) => row.field);
}

/* @invariant THE PUSH TO APPLE IS ANSWERED AS A STATE, NEVER AS A RUN. The
 * platform dispatches the Safari listing push on the project's mirror and
 * answers with the run it found: its URL, its id and the mirror's name. Only
 * the fields named here leave this function, so an answer carries whether
 * the push started, where it stands and why it failed, and never a URL to
 * the run, a run id or a mirror. An older platform answers dispatched true
 * or false with a reason, which reads as dispatched or failed here.
 */
const NOT_ON_LANE = "not-on-lane";

const NOT_ON_LANE_SENTENCE =
  "Pushing the App Store listing does not run on the extension.dev lane yet, so the listing was saved here and not pushed to the store.";

export function notOnLaneSentence(state: Pick<PushState, "reason" | "handPath">): string {
  return byHandSentence(state.reason || NOT_ON_LANE_SENTENCE, { ...(state.handPath ? { handPath: state.handPath } : {}) });
}

export function readPushState(raw: unknown): PushState | null {
  if (!isRow(raw)) return null;

  const status =
    oneOf(raw.status, PUSH_STATUSES) ??
    (raw.dispatched === true ? "dispatched" : raw.dispatched === false ? "failed" : undefined);
  if (!status) return null;

  const state: PushState = { status };
  const runState = oneOf(raw.runState, RUN_STATES);
  const fields = Array.isArray(raw.fieldsWritten)
    ? raw.fieldsWritten.length
    : typeof raw.fieldsWritten === "number"
      ? raw.fieldsWritten
      : undefined;
  const reason = text(raw.message) || text(raw.reason);
  const owed = owedOf(raw.owed);
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(text).filter(Boolean) : [];

  if (runState) state.runState = runState;
  if (text(raw.failedStep)) state.failedStep = text(raw.failedStep);
  if (text(raw.failedReason)) state.failedReason = text(raw.failedReason);
  if (text(raw.dispatchedAt)) state.dispatchedAt = text(raw.dispatchedAt);
  if (text(raw.retryHint)) state.retryHint = text(raw.retryHint);
  if (reason) state.reason = reason;
  if (text(raw.code)) state.code = text(raw.code);
  if (text(raw.handPath)) state.handPath = text(raw.handPath);
  if (text(raw.handUrl)) state.handUrl = text(raw.handUrl);
  if (text(raw.reason) === NOT_ON_LANE || state.code === STORE_ACT_NOT_ON_LANE_CODE) state.notOnLane = true;
  if (fields !== undefined) state.fieldsWritten = fields;
  if (text(raw.checkedAt)) state.checkedAt = text(raw.checkedAt);
  if (text(raw.landedAt)) state.landedAt = text(raw.landedAt);
  if (owed.length) state.owed = owed;
  if (text(raw.lockedVersion)) state.lockedVersion = text(raw.lockedVersion);
  if (text(raw.lockedState)) state.lockedState = text(raw.lockedState);
  if (warnings.length) state.warnings = warnings;

  return state;
}

const landedBefore = (state: PushState | null): boolean =>
  Boolean(state && (state.runState === "landed" || state.landedAt));

const resendable = (state: PushState | null): boolean =>
  state?.status === "unchanged" && state.runState !== "unanswered" && !landedBefore(state);

function neverLanded(sent: ProjectApiRead<Row>): boolean {
  if (sent.ok) {
    return resendable(readPushState(sent.json.appStoreConnect));
  }

  if (sent.code !== "NO_CHANGE") return false;

  const held = readPushState(isRow(sent.body) ? sent.body.appStoreConnect : null);

  return held?.runState !== "unanswered" && !landedBefore(held);
}

/* @invariant AN UNCHANGED SAFARI LISTING WHOSE PUSH NEVER LANDED IS SENT
 * AGAIN. A listing the platform calls unchanged still owes its first push to
 * App Store Connect when no push ever landed, so the write is sent once more
 * with force true and the platform's second answer is the one answered. A
 * platform that does not take force yet answers 400 or unchanged again, and
 * the first answer stands with the note that it cannot resend.
 */
export async function sendListing(
  api: ProjectApi,
  store: ListingStore,
  body: Row,
): Promise<{ sent: ProjectApiRead<Row>; resend: Resend }> {
  const route = `stores/${store}/listing`;
  const first = await projectApiSend<Row>(api, "PUT", route, body);
  if (store !== "safari" || !neverLanded(first)) return { sent: first, resend: "none" };

  const again = await projectApiSend<Row>(api, "PUT", route, { ...body, force: true });
  if (!again.ok && (again.status === 400 || again.code === "NO_CHANGE")) return { sent: first, resend: "refused" };

  return { sent: again, resend: "sent" };
}

export function pushAnswer(raw: unknown, resend: Resend, trackUrl: string): Row | null {
  const state = readPushState(raw);
  if (!state && resend !== "refused") return null;

  const byHand = state?.notOnLane && state.handPath ? { nextStep: byHandFields(notOnLaneSentence(state), state).nextStep } : {};

  return { ...(state ?? { status: "unchanged" }), ...(resend === "refused" ? { resend: "refused" } : {}), trackUrl, ...byHand };
}

const STORE_MD_LINES: Record<string, string> = {
  title: "Name",
  name: "Name",
  appStoreName: "App Store name",
  subtitle: "Subtitle",
  shortDescription: "Summary",
  summary: "Summary",
  fullDescription: "Description",
  description: "Description",
  categories: "Category",
  category: "Category",
  primaryCategory: "Category",
  searchTerms: "Search terms",
  keywords: "Search terms",
  supportEmail: "Support email",
  contactEmail: "Support email",
  homepageUrl: "Homepage",
  marketingUrl: "Homepage",
  supportUrl: "Support URL",
  privacyPolicyUrl: "Privacy policy URL",
  reviewContactPhone: "Review contact phone",
  contactPhone: "Review contact phone",
};

const RESEND_ALLOWED = /again|resend|re-send|retry|re-run|rerun|sync-listing/i;
const STORE_CONNECTION = /connect|credential|\bkey\b|secret|issuer|unauthori[sz]ed|forbidden|token|permission/i;
const LISTING_TEXT = /store\.md|character|too long|over the|invalid|category|subtitle|keyword|description|summary|title/i;

const closed = (sentence: string): string => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);

function failedNext(state: PushState): string {
  if (state.retryHint) {
    return RESEND_ALLOWED.test(state.retryHint) ? `${closed(state.retryHint)} Say sync-listing again.` : closed(state.retryHint);
  }

  const words = `${state.failedStep ?? ""} ${state.reason ?? ""}`;
  if (STORE_CONNECTION.test(words)) return "Connect the App Store in the console store settings, then say sync-listing again.";
  if (LISTING_TEXT.test(words)) return `Fix ${STORE_MD_FILENAME}, then say sync-listing again.`;

  return "Say sync-listing again.";
}

function owedSentence(owed: OwedField[]): string {
  const needs = owed.map((row) => (row.reason ? `${row.field} (${row.reason})` : row.field)).join(", ");
  const lines = [...new Set(owed.map((row) => `\`- ${STORE_MD_LINES[row.field] ?? row.field}:\``))];
  const joined = lines.length > 1 ? `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}` : lines[0];

  return `App Store Connect still needs: ${needs}; add ${joined} under the Safari section and say sync-listing again.`;
}

export function lockedSentence(state: Pick<PushState, "lockedVersion" | "lockedState" | "landedAt">): string {
  const version = state.lockedVersion || "the latest macOS version";
  const name = state.lockedState ? `${version} (${state.lockedState})` : version;
  const held = state.landedAt ? `, so Apple still holds the listing that landed ${spokenDate(state.landedAt)}` : "";

  return `The App Store listing is locked while Apple holds ${name}${held}; push the listing again once that version is editable.`;
}

export function heldSentence(landedAt: string | undefined): string {
  return landedAt ? `Apple still holds the listing that landed ${spokenDate(landedAt)}.` : "";
}

export function pushSentence(state: PushState, resend: Resend): string {
  if (state.notOnLane) return notOnLaneSentence(state);

  const at = state.landedAt || state.checkedAt;
  const when = at ? ` at ${spokenDate(at)}` : "";
  const effective =
    state.runState === "locked" ||
    (state.status === "dispatched" && (state.runState === "failed" || state.runState === "landed"))
      ? state.runState
      : state.status;
  let sentence: string;

  if (resend === "refused") {
    sentence = `The listing is unchanged and no App Store Connect push has landed; the platform cannot resend an unchanged listing yet.`;
  } else if (state.runState === "unanswered") {
    sentence = "The build lane did not answer for the recorded App Store Connect push, so nothing was sent again; say preflight in a minute and I read it again.";
  } else if (effective === "locked") {
    return state.reason ? closed(state.reason) : lockedSentence(state);
  } else if (effective === "dispatched") {
    const word = state.runState === "queued" || state.runState === "running" ? state.runState : "dispatched";
    sentence = `The App Store Connect push is ${word}; say preflight in a minute and I read what landed.`;
  } else if (effective === "failed") {
    const where = state.failedStep ? ` at ${state.failedStep}` : "";
    const why = state.reason ? `: ${closed(state.reason)}` : ".";
    const held = heldSentence(state.landedAt);
    sentence = `The App Store Connect push failed${where}${why}${held ? ` ${held}` : ""} ${failedNext(state)}`;
  } else if (effective === "landed") {
    sentence =
      state.fieldsWritten !== undefined
        ? `The push wrote ${state.fieldsWritten} fields to App Store Connect${when}.`
        : `The push landed on App Store Connect${when}.`;
  } else {
    sentence = `The listing is unchanged and its last App Store Connect push landed${when}; say preflight and I read what it carries.`;
  }

  return state.owed?.length ? `${sentence} ${owedSentence(state.owed)}` : sentence;
}
