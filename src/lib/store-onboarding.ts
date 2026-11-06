// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { decisionsOf, type Decision } from "./store-onboarding-decisions";
import { listingDraftOf, type ListingDraft } from "./store-listing-draft";
import { connectedStoresOf, readinessRowsOf, type ReadinessGroups } from "./store-onboarding-suppliers";

type Row = Record<string, unknown>;

export interface StoreReadiness {
  stores: string[];
  build: ReadinessGroups["build"];
  agentDrafts: ReadinessGroups["agent-drafts"];
  personDecides: ReadinessGroups["person-decides"];
  onFile: number;
  notOnFile: number;
  decisions: Decision[];
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

export function storeReadinessOf(args: { stores: Row; asked: readonly string[]; projectPath: string }): StoreReadiness {
  const asked = args.asked.filter((store) => STORE_NAMES[store]);
  const rows = readinessRowsOf(args.stores, asked);
  const links = connectedStoresOf(rows, asked);
  const decisions = decisionsOf({ asked, statusById: rows.statusById, projectPath: args.projectPath });
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
    listingDraft: listingDraftOf({ projectPath: args.projectPath, asked, statusById: rows.statusById }),
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
