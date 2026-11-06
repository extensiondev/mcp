// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { safariReleaseIntentOf, type SafariReleaseIntentRead } from "./safari-release-intent";
import { isRow, text } from "./ship-act";
import { uploadStopsAtDraft } from "./store-connection";
import { STORE_MD_FILENAME } from "./store-md";
import { listingForStore, parseStoreMdListing } from "./store-md-listing";

type Row = Record<string, unknown>;

export type Landing = "review" | "draft" | "testflight" | "signed-unlisted" | "nothing-sent";

export interface StoreFold {
  submissionMode?: string;
  storeMd?: string;
}

export interface ReleaseLoopStore {
  store: string;
  mode: string;
  defaultMode?: true;
  lands: Landing;
  then?: string[];
  fold?: StoreFold;
}

export interface ReleaseLoop {
  stores: ReleaseLoopStore[];
  approvals: number;
  oneApproval: boolean;
  foldCall?: string;
  watch: string;
  say: string;
}

const DEFAULT_MODES: Record<string, string> = { chrome: "draft-until-public", edge: "draft", firefox: "unlisted", safari: "draft" };
const NAMES: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };
const ORDER = ["chrome", "edge", "firefox", "safari"];
const SENDING_MODE: Record<string, string> = { chrome: "public", edge: "review", firefox: "unlisted", safari: "review" };
const RELEASE_LINE = "- Release: after approval";
const FOLD_CALL = 'extension_submit_check {action: "configure-store", store, storeSettings: {submissionMode}}; fold.storeMd goes under "## Safari" in STORE.md';

function modeOf(view: unknown, store: string): { mode: string; saved: boolean } {
  const saved = isRow(view) && isRow(view.submissionMode) ? text(view.submissionMode.id) : "";

  return saved ? { mode: saved, saved: true } : { mode: DEFAULT_MODES[store] ?? "", saved: false };
}

function safariReleaseOf(projectPath: string): SafariReleaseIntentRead {
  try {
    const parsed = parseStoreMdListing(fs.readFileSync(path.join(projectPath, STORE_MD_FILENAME), "utf8"));

    return safariReleaseIntentOf(listingForStore(parsed, "safari").listing.releaseMode);
  } catch {
    return safariReleaseIntentOf(undefined);
  }
}

function storeOf(store: string, view: unknown, release: SafariReleaseIntentRead): ReleaseLoopStore {
  const { mode, saved } = modeOf(view, store);
  const entry = (lands: Landing, then: string[], fold: StoreFold): ReleaseLoopStore => ({
    store,
    mode,
    ...(saved ? {} : { defaultMode: true as const }),
    lands,
    ...(then.length ? { then } : {}),
    ...(Object.keys(fold).length ? { fold } : {}),
  });

  if (mode === "dry-run") return entry("nothing-sent", [], { submissionMode: SENDING_MODE[store] ?? "review" });

  if (store === "chrome" || store === "edge") {
    return uploadStopsAtDraft(store, mode) ? entry("draft", ["publish"], { submissionMode: SENDING_MODE[store]! }) : entry("review", [], {});
  }

  if (store === "firefox") return entry(mode === "listed" ? "review" : "signed-unlisted", [], {});

  const reviewed = mode === "review";
  const held = release.intent === "manual";

  return entry(reviewed ? "review" : "testflight", [...(reviewed ? [] : ["publish"]), ...(held ? ["release"] : [])], {
    ...(reviewed ? {} : { submissionMode: "review" }),
    ...(held ? { storeMd: RELEASE_LINE } : {}),
  });
}

function countApprovals(stores: ReleaseLoopStore[]): number {
  const sending = stores.filter((entry) => entry.lands !== "nothing-sent");
  if (!sending.length) return 0;

  const publish = sending.some((entry) => entry.then?.includes("publish")) ? 1 : 0;
  const release = sending.some((entry) => entry.then?.includes("release")) ? 1 : 0;

  return 1 + publish + release;
}

const LANDS: Record<Landing, string> = {
  review: "goes to the store's review",
  draft: "stops at a draft",
  testflight: "stops at the TestFlight build",
  "signed-unlisted": "is signed unlisted",
  "nothing-sent": "sends nothing (dry-run)",
};

function sayOf(loop: Omit<ReleaseLoop, "say">): string {
  const lines = loop.stores.map((entry) => `${NAMES[entry.store]} ${LANDS[entry.lands]}${entry.then ? `, then ${entry.then.join(" and ")}` : ""}`);
  const cost = loop.approvals === 0 ? "sends nothing" : `costs ${loop.approvals} owner ${loop.approvals === 1 ? "approval" : "approvals"}`;
  const folds = loop.stores.some((entry) => entry.fold && entry.lands !== "nothing-sent");
  const tail = loop.oneApproval
    ? " Every store's act is on that one approval, one line per store."
    : folds
      ? " A store's fold is what would put it on one approval: less private than the default, so it is the owner's choice and never made for them."
      : "";

  return `Under the saved settings the next release ${cost}: ${lines.join("; ")}.${tail}`;
}

/* @invariant THE LOOP IS READ FROM THE SAVED SETTINGS, NEVER CHANGED BY IT.
 * A release's approval count follows what each store does with an upload
 * under its saved mode: Chrome and Edge drafts need the publish act, which
 * is one approval for every draft store at once; Safari's TestFlight build
 * needs it too unless the saved mode is review, which puts the publish line
 * on the submit's own approval; Apple holds an approved version for a
 * release act, its own approval, unless STORE.md says `- Release: after
 * approval`; Firefox signs or reviews on upload. A mode never read is the
 * least public default (Chrome draft-until-public, Edge and Safari draft,
 * Firefox unlisted), and the settings that would fold a store into one
 * approval are named as the owner's choice, never proposed as a default.
 * The loop is about the next release of a ready project, so a preflight
 * where any store read cannot submit answers no loop: what blocks it leads.
 */
export function releaseLoopOf(args: { stores: Row; asked: readonly string[]; projectPath: string }): ReleaseLoop | null {
  const asked = ORDER.filter((store) => args.asked.includes(store));
  if (!asked.length) return null;
  if (asked.some((store) => isRow(args.stores[store]) && args.stores[store].canSubmit === false)) return null;

  const release = args.projectPath.trim() ? safariReleaseOf(args.projectPath.trim()) : safariReleaseIntentOf(undefined);
  const stores = asked.map((store) => storeOf(store, args.stores[store], release));
  const approvals = countApprovals(stores);
  const watch = `extension_release_status {include: ["stores"]} after the approval: report each store live on its own read word, never an inferred one.`;
  const loop = { stores, approvals, oneApproval: approvals === 1, ...(stores.some((entry) => entry.fold) ? { foldCall: FOLD_CALL } : {}), watch };

  return { ...loop, say: sayOf(loop) };
}
