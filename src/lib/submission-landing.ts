// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

const LANDINGS: Record<string, Record<string, string>> = {
  chrome: {
    draft: "a draft Google does not review until you publish",
    "draft-until-public": "a draft Google does not review until you publish",
    public: "public once Google's review passes",
    staged: "a staged rollout to the public once Google's review passes",
    "dry-run": "nowhere, a dry run uploads nothing",
  },
  edge: {
    draft: "a Partner Center draft Microsoft does not certify until you publish",
    review: "public once Microsoft's certification passes",
    "dry-run": "nowhere, a dry run uploads nothing",
  },
  firefox: {
    unlisted: "unlisted on AMO, signed for self distribution with no review",
    listed: "listed on AMO, public once Mozilla's review passes",
    "dry-run": "nowhere, a dry run uploads nothing",
  },
  safari: {
    draft: "a TestFlight draft Apple does not review until you publish",
    review: "Apple's App Review, on sale when Apple approves it only if STORE.md says release after approval",
    "dry-run": "nowhere, a dry run uploads nothing",
  },
};

const DEFAULT_MODE: Record<string, string> = {
  chrome: "draft",
  edge: "draft",
  firefox: "unlisted",
  safari: "draft",
};

const SETTING_WORD: Record<string, string> = {
  firefox: "channel",
};

export function submissionLandingClause(store: string, mode: Row | null): string {
  const landings = LANDINGS[store];
  if (!landings) return "";

  const id = mode ? text(mode.id) : "";
  const landing = landings[id] ?? (id ? `where the saved mode ${id} sends it` : landings[DEFAULT_MODE[store] ?? ""] ?? "");
  if (!landing) return "";

  const setBy = mode && isRow(mode.setBy) && text(mode.setBy.at) ? `, set by the owner on ${text(mode.setBy.at).slice(0, 10)}` : "";
  const saved = id ? `saved ${SETTING_WORD[store] ?? "mode"} ${id}${setBy}` : `no saved ${SETTING_WORD[store] ?? "mode"}, the least public default`;

  return `${store}: ${landing} (${saved})`;
}

export function submissionLandingLine(stores: Row): string {
  const clauses = Object.entries(stores)
    .map(([store, view]) => submissionLandingClause(store, isRow(view) && isRow(view.submissionMode) ? view.submissionMode : null))
    .filter(Boolean);

  return clauses.length ? `Where an approved submit lands: ${clauses.join("; ")}.` : "";
}
