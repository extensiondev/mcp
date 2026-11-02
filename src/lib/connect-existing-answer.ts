// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { canAutoOpen, openUrl } from "./approval-open";
import { CONNECT_ACTION, CONNECT_STORE_NAMES, type ConnectStore } from "./connect-session";
import { envelope } from "./envelope";
import { failedCheckSentence, nextStep, storeSettingsUrl, workspaceReconnectSentences, workspaceStoreAccountsUrl } from "./store-connection";

import type { ConnectionCheck } from "./connect-existing";
import type { ProjectApi } from "./project-api";

const COMMAND = "extension_submit";

export interface StoreRefusal {
  message: string;
  checkedAt: string | null;
  checkedNow: boolean;
}

function capital(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function bare(words: string): string {
  return words.replace(/[.\s]+$/, "");
}

export function replaceCall(store: ConnectStore): string {
  return `${COMMAND} {action: "connect", store: "${store}", replace: true}`;
}

function replaceSentence(store: ConnectStore): string {
  return `To put a different key in its place, ask for it and I call ${replaceCall(store)}.`;
}

export function passingSentence(store: ConnectStore, check: ConnectionCheck): string {
  const name = CONNECT_STORE_NAMES[store];
  const { connection } = check;
  const account = connection.connectedAs ? ` as ${connection.connectedAs}` : "";
  const at = connection.checkedAt ? `, ${connection.checkedAt}` : "";
  const opener =
    connection.source === "workspace"
      ? `${capital(name)} is already connected through the workspace's account${account}, which covers this project, and the store accepted it at its last check${at}.`
      : check.checkedNow
        ? `${capital(name)} is already connected${account}, and the store accepted the saved key when it was checked just now${at}.`
        : `${capital(name)} is already connected${account}, and the store accepted the saved key at its last check${at}; a new check could not run now: ${bare(check.notNow)}.`;

  return `${opener} No connect page was opened and nothing was replaced. Say preflight and I read the store's readiness now. ${replaceSentence(store)}`;
}

export function uncheckedSentence(store: ConnectStore, check: ConnectionCheck): string {
  const name = CONNECT_STORE_NAMES[store];
  const account = check.connection.connectedAs ? ` as ${check.connection.connectedAs}` : "";
  const why = check.notNow ? `: ${bare(check.notNow)}` : "";

  return `${capital(name)} has a saved key${account}, but no store check has answered for it yet${why}. I did not open a connect page over it, so nothing was replaced; the store settings page shows its check when it lands. ${replaceSentence(store)}`;
}

export function refusedPrelude(store: ConnectStore, check: ConnectionCheck): string {
  const name = CONNECT_STORE_NAMES[store];
  const account = check.connection.connectedAs ? ` (${check.connection.connectedAs})` : "";
  const when = check.checkedNow ? " when it was checked just now" : " at its last check";
  const at = check.connection.checkedAt ? `, ${check.connection.checkedAt}` : "";
  const said = bare(check.connection.reason) || "no reason was recorded";

  return `The store refused the saved ${name} key${account}${when}${at}: ${said}. A new key is needed.`;
}

export function storeRefusalOf(check: ConnectionCheck): StoreRefusal {
  return { message: bare(check.connection.reason) || "no reason was recorded", checkedAt: check.connection.checkedAt, checkedNow: check.checkedNow };
}

function baseValue(api: ProjectApi, store: ConnectStore, check: ConnectionCheck, apiHint?: string) {
  const { connection } = check;

  return {
    action: CONNECT_ACTION,
    store,
    project: `${api.ref.workspace}/${api.ref.project}`,
    source: connection.source,
    connectedAs: connection.connectedAs,
    connectedAt: connection.connectedAt,
    checkedAt: connection.checkedAt,
    checkedNow: check.checkedNow,
    ...(check.notNow ? { checkNotRun: check.notNow } : {}),
    trackUrl: storeSettingsUrl(api.ref, apiHint),
    replaceCall: replaceCall(store),
  };
}

export function alreadyConnectedAnswer(api: ProjectApi, store: ConnectStore, check: ConnectionCheck, apiHint?: string): string {
  const say = passingSentence(store, check);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "already-connected",
    value: { ...baseValue(api, store, check, apiHint), opened: false, sayToPerson: say, nextStep: nextStep("preflight", say) },
    hint: say,
  });
}

export function uncheckedAnswer(api: ProjectApi, store: ConnectStore, check: ConnectionCheck, apiHint?: string): string {
  const say = uncheckedSentence(store, check);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "connection-unchecked",
    value: { ...baseValue(api, store, check, apiHint), opened: false, sayToPerson: say, nextStep: nextStep("preflight", say) },
    hint: say,
  });
}

export function workspaceFailingAnswer(api: ProjectApi, store: ConnectStore, check: ConnectionCheck, apiHint?: string): string {
  const accountsUrl = workspaceStoreAccountsUrl(api.ref, apiHint);
  const opened = canAutoOpen({ noShip: false }) ? openUrl(accountsUrl) : false;
  const reason = check.connection.reason;
  const told = check.connection.reconnect
    ? workspaceReconnectSentences(reason, accountsUrl)
    : `${failedCheckSentence(reason, store, "workspace")} The workspace's Store accounts page is ${accountsUrl}${opened ? " and is open in your browser" : ""}.`;
  const say = `${told} No project connect page was opened. To give this project a key of its own instead, ask for it and I call ${replaceCall(store)}.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "workspace-account-failing",
    value: { ...baseValue(api, store, check, apiHint), storeRefusal: storeRefusalOf(check), accountsUrl, opened, sayToPerson: say, nextStep: nextStep("connect", say, accountsUrl) },
    hint: say,
  });
}
