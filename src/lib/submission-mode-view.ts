// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { uploadStopsAtDraft } from "./store-connection";
import { SAFARI_RELEASE_LINE_SENTENCE, SUBMISSION_MODE_IDS, isStoreSettingsStore } from "./store-settings";

type Row = Record<string, unknown>;

const DRAFT_ONLY_STORES = new Set(["chrome", "edge"]);

export const SAFARI_DRAFT_FROM_HERE =
  "An upload from here stops at the TestFlight draft under this mode, and sending it to App Review is a publish act with its own approval. To let the submit's one version approval also send the build to App Review, save the review mode: extension_submit_check {action: \"configure-store\", store: \"safari\", storeSettings: {submissionMode: \"review\"}} asks for the approval a workspace owner gives once, and extension_submit with the same arguments and that approvalId saves it.";

export const SAFARI_REVIEW_FROM_HERE =
  "An upload from here goes on to App Review under this mode: the submit's version approval also covers the publish act that sends the TestFlight build to Apple.";

export type SubmissionModeSetBy = { by: string; at: string; via?: string; approvalId?: string };

export type SubmissionModeView = {
  id: string;
  label: string;
  description: string;
  fromHere?: string;
  release?: string;
  modes?: string[];
  setBy?: SubmissionModeSetBy;
  setBySay?: string;
};

function setByOf(raw: unknown): SubmissionModeSetBy | null {
  if (!isRow(raw) || text(raw.by) !== "owner" || !text(raw.at)) return null;

  return {
    by: "owner",
    at: text(raw.at),
    ...(text(raw.via) ? { via: text(raw.via) } : {}),
    ...(text(raw.approvalId) ? { approvalId: text(raw.approvalId) } : {}),
  };
}

function draftOnlyFromHere(store: string, id: string): string {
  return uploadStopsAtDraft(store, id)
    ? "An upload from here stops at the draft under this mode."
    : "An upload from here goes on to review under this mode; set the mode to its draft option in the console store settings to stop at a draft.";
}

export function submissionModeView(store: string, raw: unknown): SubmissionModeView | null {
  const mode: Row | null = isRow(raw) ? raw : null;
  const id = mode ? text(mode.id) : "";
  if (!mode || !id) return null;

  const setBy = setByOf(mode.setBy);
  const fromHere = DRAFT_ONLY_STORES.has(store)
    ? draftOnlyFromHere(store, id)
    : store === "safari" && id !== "dry-run"
      ? id === "review" ? SAFARI_REVIEW_FROM_HERE : SAFARI_DRAFT_FROM_HERE
      : "";

  return {
    id,
    label: text(mode.label),
    description: text(mode.description),
    ...(fromHere ? { fromHere } : {}),
    ...(store === "safari" ? { release: SAFARI_RELEASE_LINE_SENTENCE } : {}),
    ...(isStoreSettingsStore(store) ? { modes: [...SUBMISSION_MODE_IDS[store]] } : {}),
    ...(setBy ? { setBy, setBySay: `The workspace owner set this mode on ${setBy.at.slice(0, 10)}${setBy.approvalId ? ` under approval ${setBy.approvalId}` : ""}, so it is intended.` } : {}),
  };
}

export function submissionModeSentence(store: string, view: Row): string {
  const label = text(view.label);
  if (!label) return "";

  const tail = [text(view.setBySay), text(view.fromHere), text(view.release)].filter(Boolean).join(" ");

  return ` ${store} submission mode: ${label} (${text(view.id)}): ${text(view.description)}${tail ? ` ${tail}` : ""}`;
}
