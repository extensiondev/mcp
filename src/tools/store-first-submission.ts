// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "../lib/console-urls";
import { envelope } from "../lib/envelope";
import { kernelHook, type PageOpening } from "../lib/kernel-hooks";
import { projectApiGet, projectApiReadFailure, type ProjectApi } from "../lib/project-api";
import { badShipRequest, openShipApi, text } from "../lib/ship-act";
import { nextStep } from "../lib/store-connection";

const COMMAND = "extension_submit";

export const FIRST_SUBMISSION_ACTION = "first-submission";

export const FIRST_SUBMISSION_STORES = ["chrome", "edge"] as const;

export type FirstSubmissionStore = (typeof FIRST_SUBMISSION_STORES)[number];

export const FIRST_SUBMISSION_WAIT_MAX_SECONDS = 600;

export const FIRST_SUBMISSION_POLL_SECONDS = 30;

const NO_PAGE: Record<string, string> = {
  firefox: "Firefox AMO takes the first version, its listing and its source archive through its API, so it has no first-submission page: submit sends it.",
  safari: "The App Store's first steps (creating the app record and answering App Privacy) live in App Store Connect and have no console page yet.",
};

export interface FirstSubmissionArgs {
  store?: string;
  browsers?: string[];
  waitSeconds?: unknown;
  project?: string;
  api?: string;
}

export type FirstSubmissionState = "to-do" | "waiting" | "done";

export interface FirstSubmissionRead {
  word: string;
  storeWord: string;
  readAt: string;
  source: string;
}

export interface FirstSubmissionAnswer {
  store: FirstSubmissionStore;
  state: FirstSubmissionState;
  read: FirstSubmissionRead | null;
  checkedAt: string;
  readReason: string;
  ownerSaidAt: string;
  dashboardUrl: string;
  packageUrl: string;
  pageUrl: string;
  left: string[];
  pages: string[];
  sayToPerson: string;
  pollSeconds: number;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isFirstSubmissionStore(value: string): value is FirstSubmissionStore {
  return (FIRST_SUBMISSION_STORES as readonly string[]).includes(value);
}

function storeOf(args: FirstSubmissionArgs): string {
  const named = text(args.store).toLowerCase();
  if (named) return named;

  const browsers = Array.isArray(args.browsers) ? args.browsers.map((b) => text(b).toLowerCase()).filter(Boolean) : [];

  return browsers.length === 1 ? browsers[0]! : "";
}

function waitBound(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;

  return Math.min(FIRST_SUBMISSION_WAIT_MAX_SECONDS, Math.max(0, Math.floor(n)));
}

const rows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];

export function readFirstSubmissionAnswer(json: unknown, store: FirstSubmissionStore): FirstSubmissionAnswer | null {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const state = text(body?.state);

  if (!body || text(body.store) !== store || !["to-do", "waiting", "done"].includes(state)) return null;

  const read = body.read && typeof body.read === "object" ? (body.read as Record<string, unknown>) : null;
  const sayToPerson = text(body.sayToPerson);

  if (!sayToPerson || (state === "done" && !(read && text(read.readAt)))) return null;

  return {
    store,
    state: state as FirstSubmissionState,
    read: read && text(read.readAt) ? { word: text(read.word), storeWord: text(read.storeWord), readAt: text(read.readAt), source: text(read.source) } : null,
    checkedAt: text(body.checkedAt),
    readReason: text(body.readReason),
    ownerSaidAt: text(body.ownerSaidAt),
    dashboardUrl: text(body.dashboardUrl),
    packageUrl: text(body.packageUrl),
    pageUrl: text(body.pageUrl),
    left: rows(body.left).map((row) => text(row.label)).filter(Boolean),
    pages: rows(body.pages).map((page) => text(page.page)).filter(Boolean),
    sayToPerson,
    pollSeconds: pollSecondsOf(body.pollSeconds),
  };
}

function pollSecondsOf(raw: unknown): number {
  const n = Number(raw);

  return Number.isFinite(n) && raw !== null && raw !== "" ? Math.min(60, Math.max(0, Math.floor(n))) : FIRST_SUBMISSION_POLL_SECONDS;
}

function route(store: FirstSubmissionStore): string {
  return `stores/${store}/first-submission`;
}

function openPages(pageUrl: string, dashboardUrl: string): PageOpening {
  return kernelHook("openPagesForPerson")(dashboardUrl ? [dashboardUrl, pageUrl] : [pageUrl]);
}

const WAITED_OPENING: PageOpening = { opened: false, note: "No page was opened: this call waited on the platform's read; a call with waitSeconds: 0 opens the console page and the store dashboard." };

const DONE_OPENING: PageOpening = { opened: false, note: "No page was opened: the first submission is done, so nothing is left to finish on the console page." };

function answer(api: ProjectApi, args: FirstSubmissionArgs, read: FirstSubmissionAnswer, pageOpened: PageOpening): string {
  const opening = read.state === "done" ? DONE_OPENING : pageOpened;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const pageUrl = read.pageUrl || consoleProjectUrl(api.ref, ConsoleProjectPage.submissionsStore(read.store), args.api);
  const value = {
    action: FIRST_SUBMISSION_ACTION,
    store: read.store,
    project,
    state: read.state,
    read: read.read,
    ...(read.checkedAt ? { checkedAt: read.checkedAt } : {}),
    ...(read.readReason ? { readReason: read.readReason } : {}),
    ...(read.ownerSaidAt ? { ownerSaidAt: read.ownerSaidAt } : {}),
    left: read.left,
    pages: read.pages,
    pageUrl,
    dashboardUrl: read.dashboardUrl || null,
    ...(read.packageUrl ? { packageUrl: read.packageUrl } : {}),
    opened: opening.opened,
    ...(opening.note ? { openedNote: opening.note } : {}),
    trackUrl: pageUrl,
    sayToPerson: read.sayToPerson,
  };

  if (read.state === "done") {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "first-submission-done",
      value: { ...value, nextStep: nextStep("preflight", read.sayToPerson) },
      hint: `${read.sayToPerson} ${opening.note}`,
    });
  }

  const resume = `When they say it is submitted, call ${COMMAND} {action: "${FIRST_SUBMISSION_ACTION}", store: "${read.store}", project: "${project}", waitSeconds: 300}; it answers done only on the store's own word, read by the platform.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: read.state === "to-do" ? "first-submission-to-do" : "first-submission-waiting",
    value: { ...value, nextStep: nextStep("dashboard", read.sayToPerson, read.state === "to-do" ? pageUrl : read.dashboardUrl || pageUrl) },
    hint: [read.sayToPerson, opening.note, resume].filter(Boolean).join(" "),
  });
}

export async function openFirstSubmission(args: FirstSubmissionArgs): Promise<string> {
  const store = storeOf(args);

  if (!isFirstSubmissionStore(store)) {
    const why = NO_PAGE[store] ?? `first-submission takes one store, one of ${FIRST_SUBMISSION_STORES.join(", ")} (store, or browsers with one entry); got "${store || "none"}".`;

    return badShipRequest(COMMAND, FIRST_SUBMISSION_ACTION, "FirstSubmissionInputError", `${why} Nothing was sent.`);
  }

  const opened = await openShipApi(COMMAND, args, { action: FIRST_SUBMISSION_ACTION, store });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;

  const readOnce = async (): Promise<{ failed: string; read?: undefined } | { failed?: undefined; read: FirstSubmissionAnswer }> => {
    const sent = await projectApiGet<Record<string, unknown>>(api, route(store));

    if (!sent.ok) return { failed: projectApiReadFailure(COMMAND, sent, { api: args.api, name: "FirstSubmission", value: { action: FIRST_SUBMISSION_ACTION, store }, context: { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` } }) };

    const read = readFirstSubmissionAnswer(sent.json, store);

    return read ? { read } : { failed: badShipRequest(COMMAND, FIRST_SUBMISSION_ACTION, "FirstSubmissionUnreadable", "The platform answered the first-submission read without a state this server can relay, so nothing is claimed about the store. Read the store page on the console.") };
  };

  const first = await readOnce();
  if (!first.read) return first.failed;

  let current: FirstSubmissionAnswer = first.read;

  const waiting = waitBound(args.waitSeconds);
  const pageOpened =
    waiting === 0 && current.state !== "done"
      ? openPages(current.pageUrl || consoleProjectUrl(api.ref, ConsoleProjectPage.submissionsStore(store), args.api), current.dashboardUrl)
      : WAITED_OPENING;
  const deadline = Date.now() + waiting * 1000;

  while (current.state !== "done" && Date.now() < deadline) {
    await pause(Math.min(current.pollSeconds * 1000, Math.max(0, deadline - Date.now())));

    const next = await readOnce();
    if (!next.read) return next.failed;

    current = next.read;
  }

  return answer(api, args, current, pageOpened);
}
