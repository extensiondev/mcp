// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { canAutoOpen, openUrl } from "../lib/approval-open";
import {
  CONNECT_ACTION,
  CONNECT_STORES,
  CONNECT_STORE_NAMES,
  CONNECT_WAIT_MAX_SECONDS,
  STORE_KEY_PAGES,
  connectPageUrls,
  connectSessionRoute,
  connectedSentence,
  isConnectStore,
  pendingSentences,
  readConnectSession,
  type ConnectSession,
  type ConnectStore,
} from "../lib/connect-session";
import { envelope } from "../lib/envelope";
import {
  OWNER_REQUIRED_CODE,
  projectApiGet,
  projectApiReadFailure,
  projectApiSend,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";
import { badShipRequest, openShipApi, text } from "../lib/ship-act";
import { nextStep, storeSettingsUrl } from "../lib/store-connection";

const COMMAND = "extension_submit";

export interface StoreConnectArgs {
  store?: string;
  browsers?: string[];
  connectSession?: string;
  waitSeconds?: unknown;
  project?: string;
  api?: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function storeOf(args: StoreConnectArgs): string {
  const named = text(args.store).toLowerCase();
  if (named) return named;

  const browsers = Array.isArray(args.browsers) ? args.browsers.map((b) => text(b).toLowerCase()).filter(Boolean) : [];

  return browsers.length === 1 ? browsers[0]! : "";
}

function waitBound(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;

  return Math.min(CONNECT_WAIT_MAX_SECONDS, Math.max(0, Math.floor(n)));
}

function refusal(sent: ProjectApiRefusal, api: ProjectApi, args: StoreConnectArgs, store: ConnectStore): string {
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };
  const value = { action: CONNECT_ACTION, store, trackUrl: storeSettingsUrl(api.ref, args.api) };

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context) || sent.code === OWNER_REQUIRED_CODE) {
    return projectApiReadFailure(COMMAND, sent, { api: args.api, name: "StoreConnect", value, context });
  }

  const gone = sent.status === 404 || sent.status === 410;

  return envelope({
    ok: false,
    command: COMMAND,
    status: gone ? "connect-expired" : "connect-unavailable",
    value,
    error: { code: "E_PLATFORM", name: gone ? "ConnectSessionExpired" : "ConnectSessionUnavailable", ...(sent.code ? { platformCode: sent.code } : {}), message: sent.message },
    hint: gone
      ? `That connect session is over, so nothing was connected by it. Call ${COMMAND} {action: "connect", store: "${store}"} again for a new page and code.`
      : `The platform could not open a connect session for ${CONNECT_STORE_NAMES[store]}; nothing was saved. The store settings page ${value.trackUrl} still takes the key directly.`,
  });
}

function answer(api: ProjectApi, args: StoreConnectArgs, store: ConnectStore, session: ConnectSession, opened: boolean): string {
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const trackUrl = storeSettingsUrl(api.ref, args.api);

  if (session.status === "connected") {
    const say = connectedSentence(store, session);

    return envelope({
      ok: true,
      command: COMMAND,
      status: "store-connected",
      value: { action: CONNECT_ACTION, store, project, connectedAs: session.connectedAs, connectedAt: session.connectedAt, trackUrl, sayToPerson: say, nextStep: nextStep("preflight", say) },
      hint: say,
    });
  }

  const urls = connectPageUrls(api.ref, session, args.api);

  if (session.status === "expired") {
    const say = `The connect page for ${CONNECT_STORE_NAMES[store]} expired before a key was saved, so nothing was connected. Call ${COMMAND} {action: "connect", store: "${store}"} again for a new page and code.`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "connect-expired",
      value: { action: CONNECT_ACTION, store, project, connectSession: session.id, trackUrl, sayToPerson: say, nextStep: nextStep("connect", say) },
      error: { code: "E_PLATFORM", name: "ConnectSessionExpired", message: say },
      hint: say,
    });
  }

  const say = pendingSentences({ store, project, session, ...urls, opened });
  const resume = `When they say it is done, call ${COMMAND} {action: "connect", store: "${store}", connectSession: "${session.id}", waitSeconds: 120}; it answers the account the store named and when, never the key.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "connect-pending",
    value: {
      action: CONNECT_ACTION,
      store,
      project,
      connectSession: session.id,
      userCode: session.userCode,
      connectUrl: urls.connectUrl,
      codeUrl: urls.codeUrl,
      storeKeyUrl: STORE_KEY_PAGES[store],
      expiresAt: session.expiresAt,
      opened,
      ...(session.refusal ? { lastRefusal: session.refusal } : {}),
      trackUrl,
      sayToPerson: say,
      nextStep: nextStep("connect", say, urls.connectUrl),
    },
    hint: `${say} ${resume}`,
  });
}

function openPages(store: ConnectStore, connectUrl: string): boolean {
  if (!canAutoOpen({ noShip: false })) return false;

  const keyPage = STORE_KEY_PAGES[store];
  if (keyPage) openUrl(keyPage);

  return openUrl(connectUrl);
}

async function readSession(api: ProjectApi, store: ConnectStore, id: string) {
  return projectApiGet<Record<string, unknown>>(api, connectSessionRoute(store), { session: id });
}

export async function connectStoreAccount(args: StoreConnectArgs): Promise<string> {
  const store = storeOf(args);

  if (!isConnectStore(store)) {
    return badShipRequest(COMMAND, CONNECT_ACTION, "StoreConnectInputError", `connect takes one store, one of ${CONNECT_STORES.join(", ")} (store, or browsers with one entry); got "${store || "none"}". Nothing was sent.`);
  }

  const opened = await openShipApi(COMMAND, args, { action: CONNECT_ACTION, store });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const resumed = text(args.connectSession);
  let sent = resumed ? await readSession(api, store, resumed) : await projectApiSend<Record<string, unknown>>(api, "POST", connectSessionRoute(store), {});

  if (!sent.ok) return refusal(sent, api, args, store);

  let session = readConnectSession(sent.json, store);

  if (!session) {
    return refusal({ ok: false, status: 502, code: "", message: "The platform answered the connect session without a session.", held: false, body: sent.json }, api, args, store);
  }

  const pageOpened = resumed ? false : openPages(store, connectPageUrls(api.ref, session, args.api).connectUrl);
  const deadline = Date.now() + waitBound(args.waitSeconds) * 1000;

  while (session.status === "pending" && Date.now() < deadline) {
    await pause(Math.min(session.intervalSeconds * 1000, Math.max(0, deadline - Date.now())));

    sent = await readSession(api, store, session.id);
    if (!sent.ok) return refusal(sent, api, args, store);

    session = readConnectSession(sent.json, store) ?? session;
  }

  return answer(api, args, store, session, pageOpened);
}
