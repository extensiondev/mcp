// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveCredential } from "../lib/credential-source";
import { envelope } from "../lib/envelope";
import { type ApprovalGateInput } from "../lib/approval-gate";
import {
  OWNER_REQUIRED_CODE,
  projectApiGet,
  projectApiReadFailure,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";
import { approvalVerdict, type PolicyWrite } from "../lib/approval-policy";
import { approvedSettingsWrite } from "../lib/settings-write";
import { badShipRequest, isRow, openShipApi, text } from "../lib/ship-act";
import {
  connectionOf,
  fallbackConnectUrl,
  nextStep,
  storeSettingsUrl,
  workspaceAccountSentence,
  workspaceStoreAccountsUrl,
} from "../lib/store-connection";
import { configuredRequirementsNote } from "../lib/store-requirements";
import {
  CREDENTIAL_LABELS,
  STORE_SETTINGS_ACTION,
  STORE_SETTINGS_STORES,
  isStoreSettingsStore,
  readStoreSettingsChange,
  requestedLines,
  storeSettingsDigest,
  type StoreSettingsStore,
} from "../lib/store-settings";

export const CONFIGURE_STORE = "configure-store";

const COMMAND = "extension_submit";

const AUDIENCE_REASON = "A listed or public submission mode changes who can find the extension once a build leaves for the store, so a workspace owner approves this exact change on the approve page first; the page shows the change as the platform computed it.";
const PLATFORM_ASKED_REASON = "The platform asked a workspace owner to approve this exact change before it is saved; the approval page shows the change as the platform computed it.";

export interface ConfigureStoreArgs {
  store?: string;
  storeSettings?: unknown;
  approvalId?: string;
  project?: string;
  api?: string;
}

/* @invariant CREDENTIALS NEVER PASS THROUGH THIS SERVER, AND A CALL THAT
 * TRIES IS REFUSED BEFORE ANYTHING IS SENT. A key in storeSettings that reads
 * like a secret (issuer, secret, token, key, client, password, p8) is answered
 * with the console's connect page and the field labels the console form
 * shows, never the platform's secret names, and the platform is not asked;
 * the only settings a token may write are enabled, the submission mode, the
 * Firefox release channel, the Firefox source archive, the store's own
 * listing id (chromeItemId, edgeProductId, firefoxAddonGuid, appStoreId) and
 * the Safari bundleId, which is the project's identifier and not a secret.
 */
function credentialsConsoleOnly(args: ConfigureStoreArgs, store: StoreSettingsStore, keys: string[]): string {
  const ref = resolveCredential({ project: args.project, api: args.api }).ref;
  const connectUrl = fallbackConnectUrl(ref, store, args.api);
  const accountsUrl = store === "chrome" ? "" : workspaceStoreAccountsUrl(ref, args.api);
  const say = accountsUrl
    ? `Store credentials never pass through this server, so nothing was sent. The console takes ${CREDENTIAL_LABELS[store]} once for the whole workspace on its Store accounts page at ${accountsUrl}, and every project without its own key uses them; a project that needs a different account opens ${connectUrl}. Paste them there, then say preflight.`
    : `Store credentials never pass through this server, so nothing was sent. The console takes ${CREDENTIAL_LABELS[store]}; the form is at ${connectUrl}. Paste them there, then say preflight.`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "credentials-console-only",
    value: {
      action: CONFIGURE_STORE,
      store,
      refusedKeys: keys,
      connectUrl,
      ...(accountsUrl ? { workspaceStoreAccountsUrl: accountsUrl } : {}),
      trackUrl: storeSettingsUrl(ref, args.api),
      sayToPerson: say,
      nextStep: nextStep("connect", say, accountsUrl || connectUrl),
    },
    error: {
      code: "E_BAD_REQUEST",
      name: "StoreCredentialsConsoleOnly",
      message: `storeSettings names ${keys.map((k) => `"${k}"`).join(", ")}, and store credentials are console-only: this server never takes, stores or forwards them. Nothing was sent.`,
    },
    hint: say,
  });
}

function refusal(sent: ProjectApiRefusal, api: ProjectApi, args: ConfigureStoreArgs, store: string, settingsPage: string): string {
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };
  const value = { action: CONFIGURE_STORE, store };

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context) || sent.code === OWNER_REQUIRED_CODE) {
    return projectApiReadFailure(COMMAND, sent, { api: args.api, name: "StoreSettings", value, context });
  }

  const notTaken = sent.status === 401;
  const status = sent.status === 400 ? "bad-request" : sent.status === 404 ? "not-found" : notTaken || sent.status === 403 ? "refused" : "unavailable";

  return envelope({
    ok: false,
    command: COMMAND,
    status,
    value: { ...value, trackUrl: settingsPage },
    error: {
      code: status === "bad-request" ? "E_BAD_REQUEST" : notTaken || sent.status === 403 ? "E_AUTH_DENIED" : "E_PLATFORM",
      name: `StoreSettings${status === "bad-request" ? "InputError" : "Refused"}`,
      ...(sent.code ? { platformCode: sent.code } : {}),
      message: sent.message,
    },
    ...(notTaken
      ? {
          hint: `The platform does not take this change from a token yet, so nothing was changed; until it does, the console store settings page at ${settingsPage} is where ${store}'s publishing, submission mode and source archive are set.`,
        }
      : {}),
  });
}

export async function configureStore(args: ConfigureStoreArgs): Promise<string> {
  const store = text(args.store).toLowerCase();

  if (!store) {
    return badShipRequest(COMMAND, CONFIGURE_STORE, "StoreInputError", `configure-store needs store: one of ${STORE_SETTINGS_STORES.join(", ")}. Nothing was sent.`);
  }

  if (!isStoreSettingsStore(store)) {
    return badShipRequest(COMMAND, CONFIGURE_STORE, "StoreInputError", `store must be one of ${STORE_SETTINGS_STORES.join(", ")}; got "${args.store}". Nothing was sent.`);
  }

  const read = readStoreSettingsChange(store, args.storeSettings);
  if ("credential" in read) return credentialsConsoleOnly(args, store, read.credential);
  if ("problem" in read) return badShipRequest(COMMAND, CONFIGURE_STORE, "StoreSettingsInputError", `${read.problem} Nothing was sent.`);

  const opened = await openShipApi(COMMAND, args, { action: CONFIGURE_STORE, store });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const lines = requestedLines(store, read.requested);
  const scope = { store, settingsDigest: storeSettingsDigest(store, read.patch) };
  const settingsPage = storeSettingsUrl(api.ref, args.api);
  const preflightRead = `extension_submit (action: "preflight", browsers: ["${store}"])`;
  const policyWrite: PolicyWrite = { submissionMode: text(read.requested.submissionMode), releaseChannel: text(read.requested.releaseChannel) };
  const audienceChange = approvalVerdict(STORE_SETTINGS_ACTION, policyWrite) === "approval";
  const gate: ApprovalGateInput = {
    command: COMMAND,
    action: STORE_SETTINGS_ACTION,
    scope,
    description: `Change the ${store} store settings of ${project}: ${lines.join("; ")}.`,
    token: api.token,
    api: args.api,
    refusedStatus: "configure-store-refused",
    body: { storeSettings: { [store]: read.patch } },
    reason: audienceChange ? AUDIENCE_REASON : PLATFORM_ASKED_REASON,
    stateRead: preflightRead,
    write: policyWrite,
    refusalHint: (code) => (code === "NO_CHANGE" ? "The store settings already read this way; nothing needs changing." : undefined),
  };

  const written = await approvedSettingsWrite({
    api,
    route: "stores/config",
    body: { [store]: read.patch },
    approvalId: text(args.approvalId),
    gate,
    mismatch: () =>
      envelope({
        ok: false,
        command: COMMAND,
        status: "configure-store-refused",
        value: { action: CONFIGURE_STORE, store, settingsDigest: scope.settingsDigest },
        error: {
          code: "E_PLATFORM",
          name: "SettingsDigestMismatch",
          message: "The platform hashes this change differently from this server, so an approval of it could never be used. No approval was requested and nothing was changed.",
        },
      }),
    undone: "Nothing was changed by this call.",
    value: { action: CONFIGURE_STORE, store },
    next: {
      used: `The call that used it may already have changed the settings: read them with ${preflightRead} first, and request a fresh approval only if the change is not there.`,
    },
  });

  if (!written.ok) return written.out ?? refusal(written.sent, api, args, store, settingsPage);

  const changes = Array.isArray(written.json.changes) ? written.json.changes.filter((line): line is string => typeof line === "string") : lines;
  const config = await projectApiGet<Record<string, unknown>>(api, "stores/config").catch(() => null);
  const storeConfig = config && config.ok && isRow(config.json[store]) ? (config.json[store] as Record<string, unknown>) : null;
  const connection = storeConfig ? connectionOf(storeConfig) : null;
  const accountLine = connection?.source === "workspace" ? ` ${workspaceAccountSentence(store, connection.connectedAs)}` : "";
  const say = `The ${store} store settings are saved: ${changes.join("; ")}.${accountLine} Say preflight and I read the store's readiness now.${configuredRequirementsNote(written.json, store)}`;
  const gateLine = written.verdict === "plain" && !text(args.approvalId) ? " This was a plain setting under your own token; no approval page was involved." : "";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "store-configured",
    value: {
      action: CONFIGURE_STORE,
      store,
      project,
      storeSettings: read.requested,
      changes,
      ...(connection?.source
        ? { connection: { source: connection.source, connectedAs: connection.connectedAs, healthy: connection.healthy } }
        : {}),
      trackUrl: settingsPage,
      sayToPerson: say,
      nextStep: nextStep("preflight", say),
    },
    hint: `${project}'s ${store} store settings now read as storeSettings: ${changes.join("; ")}.${gateLine} The next submit runs under them; read the store's readiness with ${preflightRead}. The settings page is ${settingsPage}.`,
  });
}
