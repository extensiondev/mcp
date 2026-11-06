// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { broadModeSentence, REVIEW_PROMISE, uploadStopsAtDraft, type ModeIds } from "./store-connection";

type Row = Record<string, unknown>;

export interface ReviewLine {
  store: string;
  act: string;
  line: string;
}

const DRAFT_STORES = new Set(["chrome", "edge"]);

const SHORT_NAMES: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
};

const STAYS: Record<string, string> = {
  chrome: "stays a draft",
  edge: "stays a draft",
  firefox: "is signed for self distribution without a review",
  safari: "stays a TestFlight draft",
};

const SENDS_TO_REVIEW = [/^Publish sends\b/, /\bAMO's listed channel for review\b/];

const FIREFOX_LISTED_SENTENCE =
  "Under Firefox AMO's saved channel \"listed\" this upload goes to Mozilla's review after it lands and is listed publicly when it passes; to upload unlisted instead, set the channel to unlisted in the console store settings before approving.";

const shortName = (store: string): string => SHORT_NAMES[store] ?? store;

function joined(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

export function approvalLinesOf(value: unknown): ReviewLine[] {
  const raw = isRow(value) && Array.isArray(value.lines) ? value.lines : [];

  return raw.flatMap((row: unknown) => {
    if (!isRow(row)) return [];

    const store = text((row as Row).store);
    if (!store) return [];

    return [{ store, act: text((row as Row).act) || "upload", line: text((row as Row).line) }];
  });
}

export function lineGoesToReview(line: ReviewLine, modes: ModeIds): boolean {
  if (line.act === "publish") return true;
  if (line.act !== "upload") return false;
  if (SENDS_TO_REVIEW.some((pattern) => pattern.test(line.line))) return true;
  if (line.store === "firefox") return modes.firefox === "listed";

  return DRAFT_STORES.has(line.store) && !uploadStopsAtDraft(line.store, modes[line.store]);
}

export function reviewPromiseOf(stores: string[], lines: ReviewLine[], modes: ModeIds = {}): string {
  const rows = lines.length ? lines : stores.map((store) => ({ store, act: "upload", line: "" }));
  const named = [...new Set(rows.map((row) => row.store))];
  const reviewing = named.filter((store) => rows.some((row) => row.store === store && lineGoesToReview(row, modes)));

  if (reviewing.length === 0) return named.some((store) => DRAFT_STORES.has(store)) ? REVIEW_PROMISE : "";

  const staying = named.filter((store) => !reviewing.includes(store)).map((store) => `${shortName(store)} ${STAYS[store] ?? "does not go to review"}`);
  const head = `${joined(reviewing.map(shortName))} ${reviewing.length > 1 ? "go" : "goes"} to review on approval`;
  const advice = [
    ...reviewing.filter((store) => DRAFT_STORES.has(store) && !uploadStopsAtDraft(store, modes[store])).map((store) => broadModeSentence(store, String(modes[store]))),
    ...(reviewing.includes("firefox") ? [FIREFOX_LISTED_SENTENCE] : []),
  ];

  return [`${head}${staying.length ? `; ${staying.join("; ")}` : ""}.`, ...advice].join(" ");
}

export function reviewPromiseFromApproval(out: string, stores: string[], modes: ModeIds = {}): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = null;
  }

  return reviewPromiseOf(stores, approvalLinesOf(isRow(parsed) ? parsed.value : null), modes);
}
