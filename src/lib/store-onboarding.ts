// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./row";
import { uploadStopsAtDraft } from "./store-connection";
import { decisionsOf, type Decision, type DecisionId } from "./store-onboarding-decisions";
import { listingDraftOf, type ListingDraft } from "./store-listing-draft";
import { connectedStoresOf, readinessRowsOf, type ReadinessGroups } from "./store-onboarding-suppliers";

import type { ProjectFacts } from "./submit-facts";

type Row = Record<string, unknown>;

export type OpenDecision = Decision & { blocksNow: boolean };

export interface StoreReadiness {
  stores: string[];
  build: ReadinessGroups["build"];
  agentDrafts: ReadinessGroups["agent-drafts"];
  personDecides: ReadinessGroups["person-decides"];
  onFile: number;
  notOnFile: number;
  decisions: OpenDecision[];
  decisionsNeeded: number;
  connected: string[];
  notConnected: string[];
  noStoreConnected: boolean;
  listingDraft: ListingDraft | null;
  summary: string[];
}

const STORE_NAMES: Record<string, string> = {
  chrome: "the Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "the App Store",
};

const DECISION_WORDS: Record<string, string> = {
  "support-email": "support email",
  homepage: "homepage",
  "privacy-policy": "privacy policy URL",
  category: "category per store",
  distribution: "distribution (visibility, regions, price)",
  license: "Firefox license",
};

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join("");

  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function connectCalls(stores: string[]): string {
  return listOf(stores.map((store) => `extension_submit {action: "connect", store: "${store}"}`));
}

const count = (group: { required: string[]; optional: string[] }): number => group.required.length + group.optional.length;

function summaryLines(view: Omit<StoreReadiness, "summary">): string[] {
  const names = listOf(view.stores.map((store) => STORE_NAMES[store] ?? store));
  const needed = view.decisions.filter((decision) => !decision.onFile);
  const connection = view.noStoreConnected
    ? "No store is connected yet; connecting comes after the decisions and the listing draft, and no key ever passes through the chat."
    : `Connected: ${listOf(view.connected.map((store) => STORE_NAMES[store] ?? store)) || "none"}.${view.notConnected.length ? ` Not connected: ${listOf(view.notConnected.map((store) => STORE_NAMES[store] ?? store))}; ${connectCalls(view.notConnected)} ${view.notConnected.length === 1 ? "opens its" : "open each one's"} connect page.` : ""}`;

  return [
    `Readiness for ${names}: ${view.notOnFile} inputs are not on file yet and ${view.onFile} are.`,
    `${count(view.build)} come from the build, the agent can draft ${count(view.agentDrafts)}, and ${count(view.personDecides)} only you can decide.`,
    needed.length
      ? `${needed.length} ${needed.length === 1 ? "decision needs" : "decisions need"} your answer, each with a default: ${listOf(needed.map((decision) => DECISION_WORDS[decision.id] ?? decision.id))}.`
      : "Every decision is already on file.",
    connection,
  ];
}

const CHECK_OF_DECISION: Record<DecisionId, RegExp> = {
  "support-email": /support_(email|contact)/,
  homepage: /homepage|website|support_url|marketing_url/,
  "privacy-policy": /privacy_policy/,
  category: /categor/,
  distribution: /visibility|distribution|pricing/,
  license: /license/,
};

const storeOf = (id: string): string => id.split(".")[0] ?? "";

function uploadEntersReview(store: string, view: unknown): boolean {
  const mode = isRow(view) && isRow(view.submissionMode) ? text(view.submissionMode.id) : "";

  if (store === "firefox") return mode === "listed";
  if (store === "safari") return mode === "review";

  return !uploadStopsAtDraft(store, mode);
}

function blockingCheckIds(view: unknown): string[] {
  const failing = isRow(view) && Array.isArray(view.failing) ? view.failing : [];

  return failing.filter(isRow).filter((check) => text(check.severity) !== "warning" && text(check.severity) !== "info").map((check) => text(check.id));
}

/* @invariant A DECISION BLOCKS NOW ONLY WHEN THIS UPLOAD CANNOT GO WITHOUT
 * IT. A required row blocks the upload when the store's saved mode sends the
 * upload on to review (a listed Firefox channel, a Safari review mode, a
 * Chrome or Edge mode past the draft); under the least public defaults the
 * same row is only needed before a public listing, and a blocking check the
 * platform already fails for the field blocks on any mode (ledger 533).
 */
function withBlocksNow(decisions: Decision[], stores: Row, rows: ReturnType<typeof readinessRowsOf>): OpenDecision[] {
  const required = new Set([...rows.groups.build.required, ...rows.groups["agent-drafts"].required, ...rows.groups["person-decides"].required]);
  const failing = Object.values(stores).flatMap(blockingCheckIds);

  return decisions.map((decision) => ({
    ...decision,
    blocksNow:
      !decision.onFile &&
      (decision.settles.some((id) => required.has(id) && uploadEntersReview(storeOf(id), stores[storeOf(id)])) || failing.some((id) => CHECK_OF_DECISION[decision.id].test(id))),
  }));
}

export function storeReadinessOf(args: { stores: Row; asked: readonly string[]; project: ProjectFacts }): StoreReadiness {
  const asked = args.asked.filter((store) => STORE_NAMES[store]);
  const rows = readinessRowsOf(args.stores, asked);
  const links = connectedStoresOf(rows, asked);
  const decisions = withBlocksNow(decisionsOf({ asked, statusById: rows.statusById, project: args.project }), args.stores, rows);
  const view: Omit<StoreReadiness, "summary"> = {
    stores: asked,
    build: rows.groups.build,
    agentDrafts: rows.groups["agent-drafts"],
    personDecides: rows.groups["person-decides"],
    onFile: rows.onFile,
    notOnFile: rows.notOnFile,
    decisions,
    decisionsNeeded: decisions.filter((decision) => !decision.onFile).length,
    connected: links.connected,
    notConnected: links.notConnected,
    noStoreConnected: links.connected.length === 0 && links.notConnected.length > 0,
    listingDraft: listingDraftOf({ project: args.project, asked, statusById: rows.statusById }),
  };

  return { ...view, summary: summaryLines(view) };
}

const groupView = (group: { required: string[]; optional: string[] }): Row | null =>
  count(group) ? { ...(group.required.length ? { required: group.required } : {}), ...(group.optional.length ? { optional: group.optional } : {}) } : null;

export function readinessAnswer(readiness: StoreReadiness): Row | null {
  if (readiness.onFile + readiness.notOnFile === 0) return null;

  const groups = { build: groupView(readiness.build), agentDrafts: groupView(readiness.agentDrafts), personDecides: groupView(readiness.personDecides) };
  const needed = readiness.decisions.filter((decision) => !decision.onFile).map(({ onFile: _onFile, ...decision }) => decision);
  const onFile = readiness.decisions.filter((decision) => decision.onFile).map((decision) => decision.id);

  return {
    stores: readiness.stores,
    summary: readiness.summary,
    onFile: readiness.onFile,
    notOnFile: readiness.notOnFile,
    ...Object.fromEntries(Object.entries(groups).filter(([, group]) => group)),
    ...(needed.length ? { decisions: needed } : {}),
    ...(onFile.length ? { decisionsOnFile: onFile } : {}),
    ...(readiness.connected.length ? { connected: readiness.connected } : {}),
    ...(readiness.notConnected.length ? { notConnected: readiness.notConnected } : {}),
    noStoreConnected: readiness.noStoreConnected,
    ...(readiness.listingDraft ? { listingDraft: readiness.listingDraft } : {}),
  };
}

export function readinessLead(readiness: StoreReadiness, say: string): string {
  return readiness.noStoreConnected && readiness.onFile + readiness.notOnFile > 0 ? `${readiness.summary.join("\n")}\n${say}` : say;
}

const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

const answers = (n: number): string => `${countWord(n)} answer${n === 1 ? " is" : "s are"}`;

const more = (n: number): string => `${countWord(n)} more ${n === 1 ? "is" : "are"}`;

function questionList(words: string[]): string {
  if (words.length <= 2) return words.join(" and ");

  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

function categoryDefault(value: string): string {
  const pairs = value.split(", ").map((pair) => /^(.+) \((.+)\)$/.exec(pair));

  if (pairs.length === 1 && pairs[0]) return pairs[0][1] ?? value;

  return pairs.map((pair, i) => (pair ? `${pair[1]} on ${pair[2]}` : value.split(", ")[i] ?? "")).join(", ");
}

function questionOf(decision: OpenDecision): string {
  const fallback = decision.default ? ` (default ${decision.default})` : "";

  if (decision.id === "support-email") return `which support email${fallback}`;
  if (decision.id === "homepage") return `which homepage${fallback}`;
  if (decision.id === "privacy-policy") return `where your privacy policy lives${fallback}`;
  if (decision.id === "category") return `which category${decision.default ? ` (default ${categoryDefault(decision.default)})` : ""}`;
  if (decision.id === "distribution") return `who can find it and at what price${decision.default ? ` (default ${decision.default.replace(/ \([^)]*\)/g, "")})` : ""}`;

  return `which license${fallback}`;
}

const UPLOAD_WORDS: Record<string, string> = { chrome: "draft", edge: "draft", firefox: "unlisted", safari: "TestFlight" };

function uploadPhrase(readiness: StoreReadiness, stores: Row): string {
  if (readiness.stores.length !== 1) return "these uploads";

  const store = readiness.stores[0]!;

  return uploadEntersReview(store, stores[store]) ? "this upload" : `this ${UPLOAD_WORDS[store] ?? "draft"} upload`;
}

/* @invariant AN OPEN DECISION REACHES THE PERSON AS ITS QUESTION. The file
 * line and the section a decision writes stay in readiness.decisions[].writes
 * for the agent; the person hears which answer is asked, its default and
 * whether this upload waits on it, and is told the agent writes it down
 * (ledger 533).
 */
export function decisionsSentence(readiness: StoreReadiness, stores: Row): string {
  const open = readiness.decisions.filter((decision) => !decision.onFile);
  if (!open.length) return "";

  const now = open.filter((decision) => decision.blocksNow);
  const later = open.filter((decision) => !decision.blocksNow);
  const close = "Tell me and I write them down.";

  if (!now.length) return `${answers(later.length)} only needed before a public listing, not for ${uploadPhrase(readiness, stores)}: ${questionList(later.map(questionOf))}. ${close}`;

  const first = `${answers(now.length)} needed before this upload: ${questionList(now.map(questionOf))}.`;

  return later.length ? `${first} ${more(later.length)} only needed before a public listing: ${questionList(later.map(questionOf))}. ${close}` : `${first} ${close}`;
}
