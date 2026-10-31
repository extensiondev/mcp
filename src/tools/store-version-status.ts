// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { envelope, isEnvelope } from "../lib/envelope";
import { consoleProjectUrl } from "../lib/registry";
import { readsBeforeDispatch } from "../lib/store-read-landed";
import { isRow, text } from "../lib/ship-act";
import { releaseTypeMeaning } from "../lib/store-row-sources";
import { readStores } from "./store-status";

import type { NextStep } from "../lib/store-connection";

const COMMAND = "extension_submit";

const STATUS_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export const STORES_READ_CALL = 'extension_release_status {include: ["stores"]}';

export interface StoreVersionStatus {
  store: string;
  submissionId: string | null;
  version: string | null;
  buildNumber: number | null;
  status: string | null;
  state: string | null;
  readAt: string | null;
  source: string | null;
  releaseType: string | null;
  nextStep: NextStep | null;
}

type Row = Record<string, unknown>;

function wantedStores(args: { browsers?: unknown; store?: unknown }): string[] | { refused: string } {
  const named = [
    ...(Array.isArray(args.browsers) ? args.browsers : []),
    ...(text(args.store) ? [args.store] : []),
  ].map((store) => text(store).toLowerCase());
  const unknown = named.filter((store) => !(STATUS_STORES as readonly string[]).includes(store));

  if (unknown.length) return { refused: `status reads ${STATUS_STORES.join(", ")}; got ${unknown.join(", ")}. Nothing was read.` };

  return named.filter((store, index) => named.indexOf(store) === index);
}

function statusOfRow(row: Row): StoreVersionStatus {
  const submission: Row = isRow(row.lastSubmission) ? row.lastSubmission : {};
  const read: Row = isRow(submission.statusRead) ? submission.statusRead : {};
  const review: Row = isRow(submission.storeReview) ? submission.storeReview : {};
  const storeVersion: Row = isRow(submission.storeVersion) ? submission.storeVersion : {};
  const buildNumber = typeof storeVersion.buildNumber === "number" ? storeVersion.buildNumber : null;

  return {
    store: text(row.store),
    submissionId: text(submission.id) || null,
    version: text(storeVersion.packaged) || text(submission.version) || null,
    buildNumber,
    status: text(submission.status) || null,
    state: text(read.storeWord) || text(review.state) || null,
    readAt: text(read.readAt) || text(review.checkedAt) || null,
    source: text(read.source) || null,
    releaseType: text(submission.releaseType) || null,
    nextStep: isRow(row.nextStep) ? (row.nextStep as unknown as NextStep) : null,
  };
}

function landedUnsourced(entry: StoreVersionStatus, refresh: Row | null, wait: Row | null): string {
  const own = refresh?.[entry.store];
  const dispatchedAt = isRow(own) ? text(own.dispatchedAt) : "";
  const readAt = Date.parse(entry.readAt ?? "");
  if (entry.source || wait?.landed !== true || !dispatchedAt || !(readAt >= Date.parse(dispatchedAt))) return "";

  return ` (the store check this call asked for landed at ${entry.readAt}, after its dispatch at ${dispatchedAt}, but the platform answered no source for that read, so it grounds no next step)`;
}

function storeSentence(entry: StoreVersionStatus, refresh: Row | null, wait: Row | null): string {
  if (!entry.version && !entry.status) return `${entry.store}: no submission recorded`;

  const build = entry.buildNumber ? ` build ${entry.buildNumber}` : "";
  const state = entry.state ? `, the store says ${entry.state}` : "";
  const read = entry.source
    ? ` (${entry.source}${entry.readAt ? ` at ${entry.readAt}` : ""})`
    : landedUnsourced(entry, refresh, wait) || " (no store read behind it)";
  const meaning = releaseTypeMeaning(entry.releaseType ?? undefined);
  const release = entry.releaseType ? `, release type ${entry.releaseType}${meaning ? ` (${meaning})` : ""}` : "";
  const next = entry.nextStep ? `. Next: ${entry.nextStep.say}` : "";

  return `${entry.store} ${entry.version ?? ""}${build}: ${entry.status ?? "recorded"}${state}${read}${release}${next}`;
}

const STEP_ORDER = ["release", "watch"];

function overallStep(entries: StoreVersionStatus[]): NextStep | null {
  const steps = entries.map((entry) => entry.nextStep).filter((step): step is NextStep => Boolean(step));

  return steps.sort((a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind))[0] ?? null;
}

export async function storeVersionStatus(args: {
  project?: string;
  browsers?: unknown;
  store?: unknown;
  waitSeconds?: unknown;
  api?: string;
}): Promise<string> {
  const wanted = wantedStores(args);

  if (!Array.isArray(wanted)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      error: { code: "E_BAD_REQUEST", name: "StatusInputError", message: wanted.refused },
    });
  }

  const raw = await readStores({
    project: args.project,
    api: args.api,
    caller: COMMAND,
    ...(args.waitSeconds !== undefined && wanted.length ? { refresh: wanted, waitSeconds: args.waitSeconds } : {}),
  });
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!isEnvelope(parsed) || parsed.ok !== true) {
    const frame: Row = isRow(parsed) ? parsed : {};
    const refused: Row = isRow(frame.value) ? frame.value : {};
    const refusedRef = text(refused.workspace) && text(refused.project) ? { workspace: text(refused.workspace), project: text(refused.project) } : null;
    const storePage = wanted.length === 1 && refusedRef && text(refused.trackUrl) ? consoleProjectUrl(refusedRef, ConsoleProjectPage.submissionsStore(wanted[0] ?? ""), args.api) : "";
    const hint = typeof frame.hint === "string" && storePage ? frame.hint.split(text(refused.trackUrl)).join(storePage) : frame.hint;

    return envelope({
      ok: false,
      command: COMMAND,
      status: text(frame.status) || "unavailable",
      value: storePage ? { ...refused, trackUrl: storePage, nextStep: isRow(refused.nextStep) ? { ...refused.nextStep, url: storePage } : refused.nextStep } : refused,
      error: isRow(frame.error)
        ? (frame.error as { code: "E_PLATFORM"; name?: string; message: string })
        : { code: "E_PLATFORM", name: "StatusUnavailable", message: "the store read answered nothing usable" },
      ...(typeof hint === "string" ? { hint } : {}),
    });
  }

  const value: Row = isRow(parsed.value) ? parsed.value : {};
  const rows = (Array.isArray(value.stores) ? value.stores : []).filter(isRow);
  const picked = wanted.length
    ? wanted.map((store) => rows.find((row) => row.store === store) ?? { store })
    : rows.filter((row) => row.configured === true || isRow(row.lastSubmission));
  const stores = picked.map(statusOfRow);
  const step = overallStep(stores);
  const wait = isRow(value.refreshWait) ? value.refreshWait : null;
  const refresh = isRow(value.refresh) ? value.refresh : null;
  const waitSentence = wait
    ? wait.landed === true
      ? `The store check this call asked for landed within ${String(wait.waitedSeconds)} s, so these are the states it read. `
      : `The store check this call asked for had not landed after ${String(wait.waitedSeconds)} s, so these are the states before it${readsBeforeDispatch(stores, refresh)}. `
    : "";
  const ref = text(value.workspace) && text(value.project) ? { workspace: text(value.workspace), project: text(value.project) } : null;
  const trackUrl = stores.length === 1 && ref ? consoleProjectUrl(ref, ConsoleProjectPage.submissionsStore(stores[0].store), args.api) : text(value.consoleStoresUrl);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "status-read",
    value: {
      action: "status",
      workspace: value.workspace,
      project: value.project,
      stores,
      ...(refresh ? { refresh } : {}),
      ...(wait ? { refreshWait: wait } : {}),
      nextStep: step,
      trackUrl: trackUrl || undefined,
    },
    hint: `${waitSentence}${stores.length ? stores.map((entry) => storeSentence(entry, refresh, wait)).join(". ") : "No store has a submission recorded"}. This reads the same store records as ${STORES_READ_CALL}, which answers the full store picture; only a state a store check or the publish answer read grounds a next step.`,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
  });
}
