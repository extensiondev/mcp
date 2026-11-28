// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { autoOpenBlock, lanePageUrl, notOpenedNote, openCommandBlock, openPagesForPerson } from "./approval-open";
import { askingOnly } from "./ask-only";
import { APPROVALS_REQUEST_TOOL, actCall } from "./approvals-request";
import { PACKAGE_HOLD_FACT } from "./build-inputs";
import { localPackageHolds } from "./build-inputs-local";
import { resolveCredential, type CredentialRef } from "./credential-source";
import { composedRefusal, relayedAnswer } from "./composed-refusal";
import { NO_TOKEN_MESSAGE, expiredLoginsInWorkspace, loginStep, noStoredLoginHint } from "./credentials";
import { envelope, isEnvelope, reframed } from "./envelope";
import { forwardSession, withForwardSession, type ForwardSession } from "./forward-approval-state";
import { approvalHeldByPerson, forgetApprovalHolders } from "./forwarded-approval";
import { forgetForwardCredential, forwardCredential, forwardUrlFor, type ExchangedCredential } from "./forward-credential";
import { CONNECTED_STATUS, GUIDED_CONNECT_STORES, GUIDED_STATUS } from "./guided-connect";
import { loadHeldBatch } from "./held-batches";
import { ACT_SETTLE_WINDOW_MS, FOLLOW_READ_TOOL, FORWARD_TIMEOUT_MS, IN_FLIGHT_RECHECK_MS, LOCAL_TOOLS_STILL_WORK, MEMORY_KEY, buildFollowOf, carriedMemory, followSettled, followedBuildAnswer, hostedWaitOf, lostAnswer, readLane, takeMemory, unreadableAnswer, withOneNotice, withWholeWait, withoutHostedWait } from "./forward-lane-answer";
import { CLOSED_STATUSES, readAnswer, readLanePreflight, withLanePreflight } from "./forward-lane-preflight";
import { kernelHook, registeredKernelHooks } from "./kernel-hooks";
import { expiredLoginRefusal } from "./login-expired";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { outcomeClock } from "./outcome-clock";
import { resolveProjectIdentity } from "./project-identity";
import { bearerFetch, unreachedBy } from "./platform-fetch";
import { PROJECT_HEADER } from "./request-fetch";
import { identityHeaders } from "./session-identity";
import { readSharedPreviews } from "./share-record";
import { listingFillable, workspaceConnectAnswer } from "./store-connection";
import { forwardSubmitFacts, imagesTheLaneWants, labeledScreenshots, withProjectRoot, type ForwardFactsArgs, type WantedImage } from "./submit-facts-forward";
import { clientProjectPathNote, storeMdSourceNote, withClientProjectPath } from "./submit-facts-local";
import { submitDryRunAnswer } from "./submit-dry-run";
import { TOOL_POLICY } from "./tool-policy";
import { reportProgress } from "./call-progress";

import { version as packageVersion } from "../../package.json";

import type { MintedApproval } from "./approval-state";
import type { ExpiredLogin } from "./credentials";
import type { ToolModule } from "./tool-dispatch";

type Args = Record<string, unknown>;

export const FORWARDER_HEADER = "x-extensiondev-forwarder";
export const FORWARDER_TWINS_HEADER = "x-extensiondev-forwarder-twins";
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const LOCAL_FACTS_KEY = "local";
export { FORWARD_TIMEOUT_MS };
export const HOSTED_DROPPED_ARGS = ["api", "projectPath"] as const;
export const PAGE_OPENING_FACT = "pageOpening";
export const RESENDS_HELD_FACT = "resendsHeldSubmit";
export const OPEN_PAGES_KEY = "openPages";
export const OPEN_PAGES_MAX = 4;
export const PAGES_NOT_OPENED_KEY = "pagesNotOpened";

const PAGES_REFUSED_WHY = "the page named is neither on extension.dev nor on a store's developer dashboard";

const pagesRefusedNote = (pages: string[]): string =>
  `Not opened, since ${pages.length > 1 ? "they are" : "it is"} neither on extension.dev nor on a store's developer dashboard: ${pages.join(", ")}. Give the person the address as text and say where it came from.`;

export interface StoredLogin {
  token: string;
  ref: CredentialRef | null;
  expired?: ExpiredLogin | null;
  note?: string | null;
}

export interface ForwarderDeps {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  version?: string;
  resolveLogin?: (options: { project?: string; api?: string }) => StoredLogin;
  storedLogins?: (api?: string) => StoredLogin[];
  guideStoreConnect?: (result: string, args: Args) => Promise<string>;
  guideFirstListing?: (result: string, args: Args) => Promise<string | null>;
}

interface ForwardRule {
  reads?: (args: Args) => boolean;
  local?: (args: Args) => boolean;
  signedOut?: true | ((args: Args, login: StoredLogin) => boolean);
  facts?: (args: Args, deps: ForwarderDeps, wanted: WantedImage[] | null) => Args | null | Promise<Args | null>;
  wants?: (body: Args) => WantedImage[] | null;
  sent?: (args: Args) => Args;
  answered?: (args: Args, body: unknown) => unknown;
  resumes?: (body: Args) => boolean;
  rereads?: (args: Args, body: Args) => boolean;
  resumesWhereStarted?: true;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function withStoreMdSource(body: unknown, note: string | null): unknown {
  if (!note || !body || typeof body !== "object" || Array.isArray(body)) return body;

  const warnings = (body as Args).warnings;
  const said = Array.isArray(warnings) ? warnings.map(String) : [];

  return said.includes(note) ? body : { ...body, warnings: [...said, note] };
}

function actionOf(args: Args, fallback: string): string {
  return text(args.action) || fallback;
}

const SUBMIT_RULE: ForwardRule = {
  facts: async (args, deps, wanted) => {
    const facts = await forwardSubmitFacts(args as ForwardFactsArgs, wanted ? { wanted } : null);
    const hold = localPackageHolds(text(args.projectPath), facts.project.gitHead);

    return { facts, ...(hold ? { [PACKAGE_HOLD_FACT]: hold } : {}), [RESENDS_HELD_FACT]: true, [PAGE_OPENING_FACT]: { block: autoOpenBlock({ noShip: false }, deps.env ?? process.env, deps.platform) } };
  },
  wants: imagesTheLaneWants,
  sent: (args) => {
    const shaped = args.screenshots === undefined ? args : { ...args, screenshots: labeledScreenshots(args as ForwardFactsArgs) };

    return guidedConnectStore(args) ? { ...shaped, waitSeconds: 0 } : shaped;
  },
  answered: (args, body) => withStoreMdSource(withStoreMdSource(withProjectRoot(body, args.projectPath), storeMdSourceNote(args)), clientProjectPathNote(args)),
};

function guidedConnectStore(args: Args): string {
  if (text(args.action) !== "connect" || text(args.connectSession) || args.replace === true || text(args.replace).toLowerCase() === "true") return "";

  const named = text(args.store).toLowerCase();
  const browsers = Array.isArray(args.browsers) ? args.browsers.map((entry) => text(entry).toLowerCase()).filter(Boolean) : [];
  const store = named || (browsers.length === 1 ? (browsers[0] ?? "") : "");

  return GUIDED_CONNECT_STORES.has(store) ? store : "";
}

/* @invariant A PROJECT CONNECT FOR A STORE THE GUIDED BROWSER CAPTURES ENDS
 * IN THAT BROWSER. Store accounts are kept per workspace and every project
 * without a key of its own uses the workspace's, and only the workspace's
 * Store accounts page takes the one-time console sign-in and guides the
 * person to the key page. So when the lane answers that the project has no
 * working key and none on file, the pages it names stay closed and the
 * workspace's guided connect opens instead, in the same call, or, when the
 * workspace already holds that store, the answer says so and opens nothing
 * (ledger 1120). A replace, a
 * resumed session, a key of the project's own, or a guided browser that did
 * not open keeps the lane's answer and its pages (ledger 1112).
 */
async function guidedProjectConnect(command: string, args: Args, shown: Args, deps: ForwarderDeps): Promise<string | null> {
  const store = command === "extension_submit" ? guidedConnectStore(args) : "";
  const value = shown.value && typeof shown.value === "object" ? (shown.value as Args) : null;
  if (!store || !value || laneStatus(shown) !== "connect-pending" || value.storeRefusal || value.keyOnFile) return null;

  const project = text(value.project);
  const workspace = project.includes("/") ? (project.split("/")[0] ?? "") : "";
  const guide = deps.guideStoreConnect ?? (registeredKernelHooks().includes("guideStoreConnect") ? kernelHook("guideStoreConnect") : undefined);
  if (!workspace || !guide) return null;

  const api = text(args.api) || undefined;
  const answer = await guide(workspaceConnectAnswer(command, workspace, [store], api, project), { ...args, browsers: [store] });

  const status = laneStatus(readAnswer(answer));

  return status === GUIDED_STATUS || status === CONNECTED_STATUS ? answer : null;
}

async function guidedFirstListing(command: string, args: Args, shown: Args, deps: ForwarderDeps): Promise<string | null> {
  if (command !== "extension_submit" || actionOf(args, "") !== "first-submission" || Number(args.waitSeconds ?? 0) > 0) return null;

  const guide = deps.guideFirstListing ?? (registeredKernelHooks().includes("guideFirstListing") ? kernelHook("guideFirstListing") : undefined);
  if (!guide) return null;

  return guide(JSON.stringify(shown), args);
}

const GUIDED_LISTING_STATUS = "first-listing-guided";

const FIRST_SUBMISSION_BLOCKED = "first-submission-blocked";

function storesToFill(value: Args): Array<"chrome" | "edge"> {
  const gaps = Array.isArray(value.notSynced) ? (value.notSynced as Args[]) : [];
  const stores = value.stores && typeof value.stores === "object" ? (value.stores as Args) : {};
  const edge = stores.edge && typeof stores.edge === "object" ? (stores.edge as Args) : {};
  const images = edge.images && typeof edge.images === "object" ? (edge.images as Args) : {};
  const blocking = Array.isArray(edge.stillBlocking) ? edge.stillBlocking.map((id) => text(id)) : [];
  const edgeLogo = Boolean(text(images.storeLogo)) || blocking.includes("edge.store_logo");

  return [...(gaps.some((gap) => text(gap?.store) === "chrome") ? ["chrome" as const] : []), ...(edgeLogo ? ["edge" as const] : [])];
}

function sentFactsOf(sent: Args): Args | null {
  const local = sent[LOCAL_FACTS_KEY];
  if (!local || typeof local !== "object") return null;

  const { [MEMORY_KEY]: _memory, ...facts } = local as Args;

  return Object.keys(facts).length ? facts : null;
}

async function guidedFillOf(call: LaneCall, args: Args, store: "chrome" | "edge", project: string, guide: (result: string, args: Args) => Promise<string | null>): Promise<Args | null> {
  const ask: Args = { action: "first-submission", store, project, waitSeconds: 0, ...(text(args.api) ? { api: text(args.api) } : {}) };
  const read = await askLane({ ...call, reads: true, key: crypto.randomBytes(24).toString("base64url"), sent: hostedArgs(ask, sentFactsOf(call.sent), call.session.resource) });
  if (read.kind !== "answer") return null;

  const sheet = takeMemory(call.session.resource, read.body);
  const sheetValue = sheet && typeof sheet === "object" ? (sheet as Args).value : null;

  if (!listingFillable(store, laneStatus(sheet), sheetValue)) {
    const error = sheet.ok === false && sheet.error && typeof sheet.error === "object" ? text((sheet.error as Args).message) : "";
    const why = laneStatus(sheet) === FIRST_SUBMISSION_BLOCKED ? `the ${store} first listing is not ready yet` : `the ${store} first-submission sheet could not be read`;
    const note = error ? `No guided window was opened, since ${why}: ${error}` : "";

    return note ? { hint: note, guidedFill: { opened: false, note } } : null;
  }

  let guided: Args;

  try {
    guided = JSON.parse((await guide(JSON.stringify(sheet), { ...ask, refill: true })) ?? "null") as Args;
  } catch {
    return null;
  }

  if (!guided || !guided.value || typeof guided.value !== "object") return null;

  if (laneStatus(guided) !== GUIDED_LISTING_STATUS) {
    const shut = (guided.value as Args).guidedBrowser;
    const note = shut && typeof shut === "object" ? text((shut as Args).note) : "";

    return note ? { hint: note, guidedFill: { opened: false, note } } : null;
  }

  const fill = guided.value as Args;

  return {
    hint: text(guided.hint),
    guidedFill: { opened: true, ...(fill.progress ? { progress: fill.progress } : {}), ...(text(fill.sayToPerson) ? { sayToPerson: text(fill.sayToPerson) } : {}), ...(fill.nextStep ? { nextStep: fill.nextStep } : {}) },
  };
}

/* @invariant A LISTING FIELD NO STORE API TAKES IS TYPED IN BY THE GUIDED
 * WINDOW WHEN IT CAN BE (MCP ledgers 1224 and 1230). Google's API takes none
 * of the Chrome listing fields, and Edge's takes no listing image, so a
 * sync-listing answer that names chrome under notSynced, or leaves Edge's
 * 300x300 store logo open, reads that store's first-submission sheet once
 * more; while the sheet is still to do or waiting, the same guided window a
 * first-submission call opens fills the dashboard (Edge's store logo is the
 * platform's own resize of the build icon) and stops before Submit for
 * review or Publish, and the sync answer carries its progress. A Chrome
 * item Chrome already serves is filled the same way for its update, leaving
 * its Distribution as served (ledger 1239). Any other item already sent for
 * review, a sheet that cannot be read, or a window that does not open leaves
 * the sync answer as the lane gave it.
 */
async function guidedListingFill(call: LaneCall, args: Args, shown: Args, deps: ForwarderDeps): Promise<Args | null> {
  if (call.command !== "extension_submit" || actionOf(args, "") !== "sync-listing") return null;

  const value = shown.value && typeof shown.value === "object" ? (shown.value as Args) : null;
  const project = text(value?.project);
  const guide = deps.guideFirstListing ?? (registeredKernelHooks().includes("guideFirstListing") ? kernelHook("guideFirstListing") : undefined);

  if (!value || !project || !guide) return null;

  const fills: Partial<Record<"chrome" | "edge", Args>> = {};

  for (const store of storesToFill(value)) {
    const fill = await guidedFillOf(call, args, store, project, guide);
    if (fill) fills[store] = fill;
  }

  if (!fills.chrome && !fills.edge) return null;

  const gaps = Array.isArray(value.notSynced) ? (value.notSynced as Args[]) : [];
  const stores = value.stores && typeof value.stores === "object" ? (value.stores as Args) : {};
  const edgeRow = stores.edge && typeof stores.edge === "object" ? (stores.edge as Args) : null;

  return {
    ...shown,
    value: {
      ...value,
      ...(fills.chrome ? { notSynced: gaps.map((gap) => (text(gap?.store) === "chrome" ? { ...gap, guidedFill: fills.chrome!.guidedFill } : gap)) } : {}),
      ...(fills.edge && edgeRow ? { stores: { ...stores, edge: { ...edgeRow, guidedFill: fills.edge.guidedFill } } } : {}),
    },
    hint: [text(fills.chrome?.hint), text(fills.edge?.hint), text(shown.hint)].filter(Boolean).join(" "),
  };
}

/* @invariant AN ASK-ONLY CALL REACHES THE LANE UNDER THE ASK-ONLY TOOL'S NAME,
 * OR NOT AT ALL. The asking-only mark lives in this process and does not cross
 * the wire, so a call the dispatcher runs as another tool while asking only is
 * sent as the tool the person called, and the lane's own dispatcher puts the
 * mark back before anything runs. A tool with no ask-only name runs here.
 */
function laneToolOf(command: string): string | null {
  if (!askingOnly() || TOOL_POLICY[command]?.actsAs) return command;
  if (actCall()?.requested) return APPROVALS_REQUEST_TOOL;

  return Object.keys(TOOL_POLICY).find((name) => TOOL_POLICY[name]?.actsAs?.askingOnly && TOOL_POLICY[name]?.actsAs?.tool === command) ?? null;
}

const reading =
  (fallback: string, ...actions: string[]) =>
  (args: Args): boolean =>
    actions.includes(actionOf(args, fallback));

const FIRST_SUBMISSION_WAITING = new Set(["first-submission-to-do", "first-submission-waiting"]);

function firstSubmissionWaitRereads(args: Args, body: Args): boolean {
  return actionOf(args, "") === "first-submission" && Number(args.waitSeconds ?? 0) > 0 && FIRST_SUBMISSION_WAITING.has(laneStatus(body));
}

function withWholeFirstSubmissionWait(body: Args, seconds: number): Args {
  if (typeof body.hint !== "string") return body;

  return { ...body, hint: body.hint.replace(/\bThis call waited \d+ s reading\b/, `This call waited ${seconds} s reading`) };
}

function endedEarly(body: Args, waited: number, asked: number, why: string): Args {
  const plain = withoutHostedWait(body);
  const said = `This call waited ${waited} s of the ${asked} s asked and ended early: ${why} The answer is the last read; call it again with waitSeconds to keep waiting.`;

  return { ...plain, warnings: [...(Array.isArray(plain.warnings) ? plain.warnings : []), said] };
}

function legEnding(answer: LaneAnswer): string {
  if (answer.kind === "lost") return `the platform did not answer the next read (${answer.httpStatus ? `HTTP ${answer.httpStatus}, ` : ""}${answer.reason}).`;
  if (answer.kind === "stale-credential") return "the login this server holds for extension.dev was refused on the next read.";

  return "the platform refused the next read.";
}

function submitReads(args: Args): boolean {
  const action = actionOf(args, "submit");

  return action === "preflight" || action === "status" || (action === "submit" && args.dryRun !== false);
}

/* @invariant A STATUS CALL THAT ASKS FOR A REFRESH IS AN ACT. A refresh
 * makes the platform read the stores again and write what it found, so it
 * is sent, retried and reported lost as an act, the way the lane counts it.
 */
function refreshes(args: Args): boolean {
  const asked = args.refresh;

  return Array.isArray(asked) ? asked.length > 0 : asked !== undefined && asked !== null && asked !== false;
}

export const FORWARDED_TOOLS: Readonly<Record<string, ForwardRule>> = Object.freeze({
  extension_approvals: { reads: reading("status", "status", "list") },
  extension_release_status: { reads: (args) => !refreshes(args) },
  extension_release_promote: {},
  extension_workspace: { reads: reading("info", "info", "projects", "usage", "settings") },
  extension_shares: {
    reads: reading("list", "list"),
    local: (args) => actionOf(args, "list") === "create",
    facts: (args) => (text(args.projectPath) ? { sharedPreviews: readSharedPreviews(text(args.projectPath)) } : null),
    signedOut: (args, login) => !login.expired && actionOf(args, "list") === "list" && text(args.projectPath) !== "",
  },
  extension_workspace_create: { local: (args) => !text(args.deviceCode), signedOut: true, resumesWhereStarted: true },
  extension_project_create: { local: (args) => !text(args.deviceCode), signedOut: true, resumesWhereStarted: true },
  extension_auth: { local: () => true },
  extension_builds: { reads: () => true, local: (args) => actionOf(args, "list") === "download" },
  extension_builds_act: {},
  extension_preview_web: { local: () => true },
  extension_publish: { local: (args) => actionOf(args, "publish") === "sync-captures" },
  extension_submit: { reads: submitReads, ...SUBMIT_RULE, resumes: (body) => laneStatus(body) === SUBMIT_DISPATCHED_STATUS, rereads: firstSubmissionWaitRereads },
  extension_submit_check: { reads: submitReads, ...SUBMIT_RULE },
});

/* @invariant A DEVICE FLOW RESUMES WHERE IT STARTED. Every create starts
 * in this process: with no login its grant, rows and list stay in this
 * machine's files and memory, and with a login they go to www's forward
 * state. Every later call that carries its deviceCode runs here the same
 * way, outside the forward session or inside it, and is never sent to the
 * lane, which holds none of it. Until 2026-11-19 a batch started signed out
 * sent its second resume to the lane once the logins it minted were stored,
 * and the lane refused the list by an older copy's rules, so an approved
 * grant created 3 of 7 (ledger 956).
 */
type StartedIn = "bare" | "session";

const startedHere = new Map<string, StartedIn>();

function deviceKey(api: string, deviceCode: string): string {
  return `${api}\n${deviceCode}`;
}

function resumedIn(api: string, args: Args): StartedIn | null {
  const deviceCode = text(args.deviceCode);
  if (!deviceCode) return null;

  return startedHere.get(deviceKey(api, deviceCode)) ?? (loadHeldBatch(api, deviceCode) ? "bare" : null);
}

function rememberStart(api: string, args: Args, where: StartedIn, answer: string): string {
  const value = readAnswer(answer)?.value;
  const deviceCode = value && typeof value === "object" ? text((value as Args).deviceCode) : "";
  if (deviceCode && !text(args.deviceCode)) startedHere.set(deviceKey(api, deviceCode), where);

  return answer;
}

function startsSignedOut(rule: ForwardRule, args: Args, login: StoredLogin): boolean {
  return typeof rule.signedOut === "function" ? rule.signedOut(args, login) : rule.signedOut === true;
}

export function forwardedCallReads(command: string, args: Args): boolean {
  return FORWARDED_TOOLS[command]?.reads?.(args) === true;
}

type LaneAnswer = { kind: "answer"; body: Args } | { kind: "refused"; text: string } | { kind: "stale-credential"; text: string } | { kind: "lost"; httpStatus: number; reason: string; sent: boolean };

interface LaneCall {
  command: string;
  tool: string;
  session: ForwardSession;
  sent: Args;
  key: string;
  reads: boolean;
  deps: ForwarderDeps;
}

function refusal(command: string, status: string, code: string, message: string, hint?: string, value?: Args): string {
  return envelope({ ok: false, command, status, error: { code, message }, ...(hint ? { hint } : {}), ...(value ? { value } : {}) });
}

function ownRefusal(command: string, status: string, code: string, message: string, hint: string, value: Args): string {
  return composedRefusal({ ok: false, command, status, error: { code, message }, hint, value });
}

const ASKED_VERSION = /\b\d{1,4}\.\d{1,4}\.\d{1,4}\b/;

function exchangeRefusal(command: string, api: string, project: string | null, refused: Extract<ExchangedCredential, { ok: false }>): string {
  const said = refused.message ? ` (${refused.message})` : "";

  if (refused.status === 0) {
    return refusal(command, "offline", "E_NETWORK", `Platform tools need the network to reach ${api}, and this server could not reach it to exchange its device login for a forward credential${said}.`, `Try again shortly. ${LOCAL_TOOLS_STILL_WORK}`, { hosted: true });
  }

  if (refused.status === 503) {
    return refusal(command, "hosted-off", "E_PLATFORM", `extension.dev has not opened the hosted lane yet${said}.`, `Try again later. ${LOCAL_TOOLS_STILL_WORK}`, { hosted: true });
  }

  if (refused.status === 401 || refused.status === 403) {
    const login = `extension_auth_login (action: login${project ? `, project: "${project}"` : ""})`;

    return refusal(command, "auth-refused", "E_AUTH_DENIED", `extension.dev refused to exchange the stored login${project ? ` for ${project}` : ""} for a forward credential${said}.`, `Run ${login} on this machine to sign in again, then call ${command} again.`, { hosted: true });
  }

  return refusal(command, refused.status === 429 ? "rate-limited" : "platform-unavailable", "E_PLATFORM", `extension.dev could not mint a forward credential just now${said}.`, `Try again shortly. ${LOCAL_TOOLS_STILL_WORK}`, { hosted: true });
}

function withoutLaneStamp(body: Args): Args {
  const value = body.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || !("server" in value)) return body;

  const { server: _lane, ...kept } = value as Args;

  return { ...body, value: kept };
}

/* @invariant WHAT THE AGENT READS ABOUT THE SERVER IS THIS PROCESS, NEVER THE
 * LANE'S FUNCTION. The hosted function stamps its own version, pid and start
 * time on an answer; an agent told to end that pid would look for it on this
 * machine. The lane's stamp is dropped here, so the only value.server an
 * answer carries is the one this server's dispatcher adds. A forwarder the
 * lane calls too old is told the two steps that fix it: the package the
 * client starts is updated first, then the server is reconnected, because a
 * reload alone starts the same old version again.
 */
function laneEnvelope(command: string, answered: Args, deps: ForwarderDeps): string {
  const body = withoutLaneStamp(answered);

  if (text(body.status) === "forwarder-stale") {
    const error = (body.error && typeof body.error === "object" ? body.error : {}) as Args;
    const asked = ASKED_VERSION.exec(text(error.message))?.[0];

    return ownRefusal(
      command,
      "forwarder-stale",
      "E_SERVER_STALE",
      `This version of @extension.dev/mcp is too old for the hosted contract${asked ? `, which asks for ${asked} or newer` : ""}.`,
      `Update the package first: start @extension.dev/mcp@latest in the client's MCP configuration (npx -y @extension.dev/mcp@latest), then reconnect the server (/mcp, pick extension-dev) so the new version runs. Reconnecting alone starts version ${deps.version ?? packageVersion} again. ${LOCAL_TOOLS_STILL_WORK}`,
      { hosted: true, forwarderVersion: deps.version ?? packageVersion },
    );
  }

  relayedAnswer();

  if (isEnvelope(body)) return JSON.stringify(body);

  const error = (body.error && typeof body.error === "object" ? body.error : {}) as Args;

  return reframed({
    ok: body.ok === true,
    command,
    status: text(body.status),
    ...(body.ok === true ? {} : { error: { code: text(error.code) || "E_PLATFORM", message: text(error.message) || `The hosted lane answered ${text(body.status)} without a message.` } }),
    ...(text(body.hint) ? { hint: text(body.hint) } : {}),
    ...(body.value && typeof body.value === "object" ? { value: body.value } : {}),
    ...(Array.isArray(body.warnings) ? { warnings: body.warnings.map(String) } : {}),
  });
}

function laneStatus(body: unknown): string {
  return body && typeof body === "object" ? text((body as Args).status) : "";
}

function laneCode(body: unknown): string {
  const error = body && typeof body === "object" ? (body as Args).error : null;

  return error && typeof error === "object" ? text((error as Args).code) : "";
}

async function sendOnce(call: LaneCall, fresh: boolean): Promise<LaneAnswer> {
  const { command, tool, session, key, deps } = call;
  const exchanged = await forwardCredential({ ...session, fresh });
  if (!exchanged.ok) return { kind: "refused", text: exchangeRefusal(command, session.api, session.project, exchanged) };

  const requested = tool === APPROVALS_REQUEST_TOOL ? actCall() : undefined;
  const sentBody = JSON.stringify({ tool, args: requested?.requested ? requestBody(requested.act, call.sent) : call.sent });
  let res: Response;

  try {
    res = await bearerFetch(
      session.resource,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${exchanged.credential.token}`,
          accept: "application/json",
          "content-type": "application/json",
          [FORWARDER_HEADER]: deps.version ?? packageVersion,
          [FORWARDER_TWINS_HEADER]: "1",
          [IDEMPOTENCY_HEADER]: key,
          ...(session.project ? { [PROJECT_HEADER]: session.project } : {}),
          ...identityHeaders(command),
        },
        body: sentBody,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      },
      deps.fetchImpl,
    );
  } catch (err) {
    const unreached = unreachedBy(session.resource, err, FORWARD_TIMEOUT_MS);

    return { kind: "lost", httpStatus: 0, reason: unreached.message, sent: unreached.kind !== "dns" };
  }

  const read = await readLane(res);

  if (read.kind === "lost") return { ...read, sent: true };

  if (read.kind === "unreadable") {
    const facts = call.sent[LOCAL_FACTS_KEY];

    return { kind: "refused", text: unreadableAnswer({ command, resource: session.resource, read, sentBytes: Buffer.byteLength(sentBody), factsBytes: facts ? Buffer.byteLength(JSON.stringify(facts)) : 0 }) };
  }

  if (laneCode(read.body) === "E_AUTH_DENIED" && exchanged.cached) {
    forgetForwardCredential(session);

    return { kind: "stale-credential", text: laneEnvelope(command, read.body, deps) };
  }

  return { kind: "answer", body: read.body };
}

/* @invariant A LOST ANSWER IS ASKED FOR AGAIN WITH THE SAME KEY, AND AN ACT
 * THAT MAY HAVE RUN IS NEVER REPORTED AS ONE THAT DID NOT. When the lane
 * does not answer, or its edge answers 502 or 504, the same call goes out
 * once more under the same idempotency key: a read simply runs again, and an
 * act answers its first outcome if the lane settled it. While the lane says
 * the key is still in flight and its function could still be running (65 s
 * from the first send, five past the function's limit), the key is asked
 * again every 5 s. What is still lost after that is answered by kind: a read
 * says nothing changed, an act says it may have run and names its key and
 * the record to read first.
 */
async function askLane(call: LaneCall): Promise<LaneAnswer> {
  const firstSentAt = outcomeClock.now();
  let answer = await sendOnce(call, false);

  if (answer.kind === "stale-credential") answer = await sendOnce(call, true);
  if (answer.kind !== "lost") return answer;

  answer = await sendOnce(call, false);

  while (answer.kind === "answer" && laneStatus(answer.body) === "act-in-flight" && outcomeClock.now() - firstSentAt < ACT_SETTLE_WINDOW_MS) {
    reportProgress(`${call.command} is still running on extension.dev`);
    await outcomeClock.sleep(IN_FLIGHT_RECHECK_MS);
    answer = await sendOnce(call, false);
  }

  return answer;
}

function answerText(call: LaneCall, answer: Exclude<LaneAnswer, { kind: "answer" }>): string {
  if (answer.kind !== "lost") return answer.text;

  return lostAnswer({ command: call.command, sent: call.sent, key: call.key, reads: call.reads || !answer.sent, resource: call.session.resource, httpStatus: answer.httpStatus, reason: answer.reason });
}

function hostedArgs(args: Args, facts: Args | null, resource: string): Args {
  const kept = Object.fromEntries(Object.entries(args).filter(([key]) => !(HOSTED_DROPPED_ARGS as readonly string[]).includes(key) && key !== LOCAL_FACTS_KEY));
  const memory = carriedMemory(resource);
  const local = Object.keys(memory).length ? { ...facts, [MEMORY_KEY]: memory } : facts;

  return local ? { ...kept, [LOCAL_FACTS_KEY]: local } : kept;
}

function requestBody(act: string, sent: Args): Args {
  const { [LOCAL_FACTS_KEY]: local, ...args } = sent;

  return local === undefined ? { act, args } : { act, args, [LOCAL_FACTS_KEY]: local };
}

function refOf(ref: CredentialRef | null): string | null {
  return ref ? `${ref.workspace}/${ref.project}`.toLowerCase() : null;
}

export { forgetApprovalHolders };

export async function forwardedApproval(command: string, args: Args, deps: ForwarderDeps = {}): Promise<MintedApproval | null> {
  return FORWARDED_TOOLS[command] ? approvalHeldByPerson(args, deps) : null;
}

function personPage(url: unknown): url is string {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();

    return parsed.protocol === "https:" || (parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "[::1]"));
  } catch {
    return false;
  }
}

/* @invariant A PAGE THE HOSTED LANE NAMES FOR THE PERSON OPENS ON THE
 * PERSON'S MACHINE, UNDER THE SAME RULES AS AN APPROVAL PAGE. The lane has
 * no browser, so the forwarder tells it up front whether this machine may
 * open a page (the pageOpening fact: --no-ship aside, the same blocks an
 * approval page obeys, EXTENSION_DEV_NO_AUTO_OPEN, CI, SSH, a headless
 * browser, no display), the lane words its answer for that, and names the
 * pages under value.openPages. They are opened here, https or loopback
 * only and at most four, and the list never reaches the agent; when the
 * open command does not start, the answer says so instead of claiming an
 * open page.
 */
function openLanePages(body: unknown, deps: ForwarderDeps): { body: unknown; unopened: string | null } {
  const lane = (body && typeof body === "object" ? body : {}) as Args;
  const named = lane.value && typeof lane.value === "object" ? (lane.value as Args)[OPEN_PAGES_KEY] : undefined;
  if (!Array.isArray(named)) return { body, unopened: null };

  const pages = named.filter(personPage).slice(0, OPEN_PAGES_MAX);
  const urls = pages.map(lanePageUrl).filter(Boolean);
  const refused = pages.filter((page) => !lanePageUrl(page));
  const value = { ...Object.fromEntries(Object.entries(lane.value as Args).filter(([key]) => key !== OPEN_PAGES_KEY)), ...(refused.length ? { [PAGES_NOT_OPENED_KEY]: refused } : {}) };
  const kept = refused.length ? { ...lane, value, warnings: [...(Array.isArray(lane.warnings) ? lane.warnings : []), pagesRefusedNote(refused)] } : { ...lane, value };
  if (!urls.length) return { body: refused.length ? unopenedAnswer(kept, notOpenedNote(PAGES_REFUSED_WHY)) : kept, unopened: null };

  const env = deps.env ?? process.env;
  const blocked = autoOpenBlock({ noShip: false }, env, deps.platform);
  const opening = openPagesForPerson(urls, env, deps.platform);
  if (opening.opened) return { body: kept, unopened: null };

  return { body: unopenedAnswer(kept, opening.note), unopened: blocked ? null : openCommandBlock(deps.platform) };
}

function unopenedAnswer(lane: Args, note: string): Args {
  const said = lane.value && typeof lane.value === "object" ? text((lane.value as Args).openedNote) : "";
  const hint = said && said !== note && text(lane.hint).includes(said) ? text(lane.hint).replace(said, note) : [text(lane.hint), text(lane.hint).includes(note) ? "" : note].filter(Boolean).join(" ");

  return {
    ...lane,
    value: { ...(lane.value as Args), opened: false, openedNote: note },
    hint,
    warnings: [...(Array.isArray(lane.warnings) ? lane.warnings : []), note],
  };
}

/* @invariant THE WORDS ABOUT A PAGE MATCH WHAT HAPPENED TO IT. The lane
 * writes its sentences before this machine tries to open the page, so when
 * the open command does not start, an answer that says the page is open in
 * the browser would be false. The lane is asked once more for the same
 * step's words, told the reason no page opened, with no wait and, for a
 * connect, as the session the first answer began, so nothing is started
 * twice; its second answer hands the person the url instead. If that
 * second answer does not come, the first one stands, marked not opened.
 */
async function retoldUnopened(call: LaneCall, shaped: Args, facts: Args | null, first: Args, why: string): Promise<Args | null> {
  const began = first.value && typeof first.value === "object" ? text((first.value as Args).connectSession) : "";
  const asked = { ...shaped, waitSeconds: 0, ...(began ? { connectSession: began } : {}) };
  const answer = await askLane({ ...call, key: crypto.randomBytes(24).toString("base64url"), sent: hostedArgs(asked, { ...facts, [PAGE_OPENING_FACT]: { block: why } }, call.session.resource) });
  if (answer.kind !== "answer") return null;

  const body = takeMemory(call.session.resource, answer.body);
  const value = body.value && typeof body.value === "object" ? (body.value as Args) : null;

  return body.ok === true && value && !(OPEN_PAGES_KEY in value) ? unopenedAnswer(body, notOpenedNote(why)) : null;
}

/* @invariant A PLATFORM TOOL RUNS ON THE HOSTED LANE OR NOT AT ALL, AND THE
 * FORWARDER SENDS THE LANE A PROJECT REF, NEVER A PATH, AND ONE ACT ONE KEY.
 * This package holds no platform logic: a platform call is answered by
 * mcp.extension.dev, and only the steps that touch this machine (a device
 * login, a file written or read, a build and its upload, a browser opened)
 * run here. The stored login is resolved here, exchanged at its own www for
 * a forward credential, and only that credential reaches the lane; api and
 * projectPath stay on this machine, and what the hosted half needs from the
 * project (the STORE.md, icon, screenshot and git facts of a submit, the
 * share record of a list or revoke) is read here and sent as facts, with
 * image bytes uploaded from here to www and the project root sent as a label.
 * Each call carries one idempotency key, and the forwarder's own retry (a
 * refused cached credential, a lane that did not answer) sends the same key, so
 * the lane answers the first outcome instead of acting twice. With no stored
 * login, an expired one, or an api that is not a platform address, a call
 * the lane would answer is refused here before any request leaves, in the
 * words the tool used when it ran in this process; a step that is how a
 * person without a login starts (a sign-in, a create and its device poll, a
 * preview) still runs here, and so does a share list for a project folder,
 * answered from the folder's own record with no login.
 * The lane ends every call inside its function's limit and says when it cut
 * a wait short; this process has no such limit, so a read that was cut is
 * asked again with the seconds still owed until the bound the caller asked
 * for has passed. An act is never sent twice to finish a wait: its answer
 * keeps the lane's notice and the tool's own next step. An answer that says
 * the lane is closed, and an auth status, carry what the lane's preflight
 * names as closed.
 */
export async function forwardCall(command: string, given: Args, local: (args: Args) => Promise<string>, deps: ForwarderDeps = {}): Promise<string> {
  const rule = FORWARDED_TOOLS[command];
  if (!rule || forwardSession()) return local(given);

  const args = withClientProjectPath(command, given);

  const held = submitDryRunAnswer(command, args);
  if (held) return held;

  const tool = laneToolOf(command);
  const here = rule.local?.(args) === true;
  const named = text(args.api) || undefined;
  const checked = safeApiBase(resolveApiBase(named));

  if (!checked.ok) return here ? local(args) : refusal(command, "unavailable", "E_BAD_HOST_URL", checked.message, undefined, { hosted: true });

  const resumed = rule.resumesWhereStarted ? resumedIn(checked.base, args) : null;
  if (resumed === "bare") return local(args);

  const startsHere = here || resumed === "session";
  const resource = forwardUrlFor(checked.base, deps.env);
  const login = (deps.resolveLogin ?? resolveCredential)({ project: text(args.project) || undefined, api: named });

  if (!login.token) {
    if (!startsHere && !startsSignedOut(rule, args, login)) return signedOutRefusal(command, args, login, named);

    return rule.resumesWhereStarted ? rememberStart(checked.base, args, "bare", await local(args)) : local(args);
  }

  if (!tool) return startsHere ? local(args) : askOnlyRefusal(command);

  if (!resource) {
    if (startsHere) return local(args);

    return ownRefusal(
      command,
      "hosted-unpaired",
      "E_TOOL_DISABLED",
      `${checked.base} has no hosted lane paired with it, so no login was sent.`,
      `Platform tools run on the hosted lane paired with https://www.extension.dev, or with a loopback www for development. Point api (or EXTENSION_DEV_API_URL) at one of them. ${LOCAL_TOOLS_STILL_WORK}`,
      { hosted: true },
    );
  }

  const session: ForwardSession = { api: checked.base, login: login.token, project: refOf(login.ref), resource, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  const ranHere = startsHere ? await withForwardSession(session, () => local(args)) : null;
  const answer = ranHere === null ? await forwardedAnswer({ command, tool, rule, args, session }, local, deps) : rule.resumesWhereStarted ? rememberStart(checked.base, args, "session", ranHere) : ranHere;
  const answered = readAnswer(answer);
  const closed = CLOSED_STATUSES.includes(text(answered?.status));
  if (!answered || (!closed && !(command === "extension_auth" && actionOf(args, "status") === "status"))) return answer;

  const read = await readLanePreflight(resource, deps.version ?? packageVersion, deps.fetchImpl);

  if (!read) return answer;

  relayedAnswer();

  return JSON.stringify(withLanePreflight(answered, resource, read, closed || read.closed.length > 0));
}

/* @invariant A PERSON WHO IS NOT SIGNED IN IS TOLD SO BY THIS PROCESS, AND
 * THE LANE IS NEVER ASKED. The stored logins are on this machine, so whether
 * a call has one is known before anything is exchanged: an expired login
 * names the project, the sign-in that renews it and, when www answers the
 * device start, the page that approves it; a named project with no login
 * names that project, and no login at all names the sign-in and the create
 * that comes before it. With no network the same answers come back, the
 * expired one without its page.
 */
async function signedOutRefusal(command: string, args: Args, login: StoredLogin, api: string | undefined): Promise<string> {
  if (login.expired) return expiredLoginRefusal({ command, expired: login.expired, api, extra: { ...(text(args.action) ? { action: text(args.action) } : {}), hosted: true } });

  const project = text(args.project);

  return composedRefusal({
    ok: false,
    command,
    status: "auth-required",
    value: { hosted: true },
    error: { code: "E_AUTH_REQUIRED", name: "PlatformAuthError", message: project ? noStoredLoginHint(project, expiredLoginsInWorkspace(project, api)) : (login.note ?? NO_TOKEN_MESSAGE) },
    hint: loginStep(project || undefined),
  });
}

function askOnlyRefusal(command: string): string {
  return ownRefusal(command, "ask-only", "E_TOOL_DISABLED", `${command} was called while only asking, and it has no ask-only form on the hosted lane, so nothing was sent.`, `Call ${command} itself to run it.`, { hosted: true });
}

/* @invariant A CALL MADE UNDER THE SLUG A PROJECT LEFT IS FORWARDED UNDER ITS
 * CURRENT NAME. The login store keeps the old slug as an alias of the new
 * one, so this machine resolves either name to the one login; the lane
 * knows only the credential's current project and refuses any other name.
 * Until 2026-11-15 the header carried the current slug and the arguments
 * the old one, so a read under the old name was refused by the lane as a
 * project the login does not cover.
 */
function underCurrentName(args: Args): Args {
  const named = text(args.project);
  const identity = named ? resolveProjectIdentity(text(args.api) || undefined, named) : null;

  return identity?.movedFrom ? { ...args, project: identity.current } : args;
}

/* @invariant A CUT SUBMIT WAIT IS FINISHED BY RESUME LEGS, NEVER BY SENDING
 * THE SUBMIT AGAIN. The lane ends a call before a store run finishes and
 * hands back what its submit tool remembered of the dispatch. While the
 * answer still reads dispatched and seconds of the asked wait are left, the
 * forwarder asks again with the resume mark under a new key: the lane then
 * waits on the same records and dispatches nothing, and with nothing
 * remembered it refuses, in which case the dispatched answer and the lane's
 * notice stand. A lane that handed back no remembered dispatch is one that
 * cannot resume, so it is never asked. Every other act is still sent once
 * (ledger 884).
 */
const SUBMIT_DISPATCHED_STATUS = "submit-dispatched";
const RESUME_UNKNOWN_STATUS = "nothing-to-resume";
const RESUME_ACT_FACT = "resumeAct";
const SUBMIT_DISPATCHES_SHELF = "submit-dispatches";
const SUBMIT_HELD_STATUS = "submit-held";
const PRECHECKED_ACT_FACT = "precheckedAct";
const SUBMIT_PRECHECKED_SHELF = "submit-prechecked";

const freshKey = (): string => crypto.randomBytes(24).toString("base64url");

/* @invariant A SUBMIT THE LANE HELD BEFORE ITS UPLOAD IS SENT ONCE MORE IN A
 * FRESH CALL. The lane checks the stores and the approval first, and when
 * too little of its function's time is left for the upload request it
 * sends nothing and keeps those checks on a shelf. Nothing reached www, so
 * the same act goes out again under a new key with the checked mark, and
 * the upload gets the fresh call's whole budget (ledger 1202).
 */
async function sentAfterHold(call: LaneCall, shaped: Args, facts: Args | null, body: Args): Promise<{ call: LaneCall; answer: LaneAnswer } | null> {
  const resource = call.session.resource;
  if (laneStatus(body) !== SUBMIT_HELD_STATUS || !(carriedMemory(resource)[SUBMIT_PRECHECKED_SHELF] ?? []).length) return null;

  reportProgress(`Sending ${call.command} on extension.dev in a fresh call`);
  const fresh = { ...call, key: freshKey(), sent: hostedArgs(shaped, { ...(facts ?? {}), [PRECHECKED_ACT_FACT]: true }, resource) };

  return { call: fresh, answer: await askLane(fresh) };
}

async function followedBuild(call: LaneCall, get: Args, act: Args, startedAt: number): Promise<Args> {
  const askedSeconds = hostedWaitOf(act)?.askedSeconds ?? 0;
  const project = text(call.sent.project);
  let read: Args | null = null;

  for (;;) {
    const left = askedSeconds - Math.round((outcomeClock.now() - startedAt) / 1000);
    if (left <= 0) break;

    reportProgress(`Following ${call.command} on extension.dev (${askedSeconds - left} of ${askedSeconds} s)`);
    const leg: LaneCall = {
      ...call,
      command: FOLLOW_READ_TOOL,
      tool: FOLLOW_READ_TOOL,
      key: crypto.randomBytes(24).toString("base64url"),
      reads: true,
      sent: hostedArgs({ ...(project ? { project } : {}), ...get, waitSeconds: left }, null, call.session.resource),
    };
    const answer = await askLane(leg);
    if (answer.kind !== "answer") break;

    read = takeMemory(call.session.resource, answer.body);
    if (followSettled(read) || !hostedWaitOf(read)) break;
  }

  return followedBuildAnswer(act, read, Math.round((outcomeClock.now() - startedAt) / 1000));
}

async function forwardedAnswer(asked: { command: string; tool: string; rule: ForwardRule; args: Args; session: ForwardSession }, local: (args: Args) => Promise<string>, deps: ForwarderDeps): Promise<string> {
  const { command, tool, rule, args, session } = asked;
  const resource = session.resource;
  let facts = (await rule.facts?.(args, deps, null)) ?? null;
  const shaped = underCurrentName(rule.sent?.(args) ?? args);
  let call: LaneCall = { command, tool, session, sent: hostedArgs(shaped, facts, resource), key: crypto.randomBytes(24).toString("base64url"), reads: rule.reads?.(args) === true, deps };
  const startedAt = outcomeClock.now();
  reportProgress(`Running ${command} on extension.dev`);
  let answer = await askLane(call);

  if (answer.kind !== "answer") return answerText(call, answer);

  let body = takeMemory(resource, answer.body);
  const wanted = rule.wants?.(body) ?? null;

  if (wanted) {
    facts = (await rule.facts?.(args, deps, wanted)) ?? null;
    call = { ...call, sent: hostedArgs(shaped, facts, resource), key: crypto.randomBytes(24).toString("base64url") };
    answer = await askLane(call);

    if (answer.kind !== "answer") return answerText(call, answer);

    body = takeMemory(resource, answer.body);
  }

  if (laneStatus(body) === "local-half") return withForwardSession(session, () => local(args));

  const held = await sentAfterHold(call, shaped, facts, body);

  if (held) {
    call = held.call;
    if (held.answer.kind !== "answer") return answerText(call, held.answer);

    body = takeMemory(resource, held.answer.body);
  }

  const resumes = !call.reads && rule.resumes?.(body) === true && (carriedMemory(resource)[SUBMIT_DISPATCHES_SHELF] ?? []).length > 0;
  const rereads = !call.reads && !resumes && rule.rereads?.(args, body) === true;
  let cut = call.reads || resumes || rereads ? hostedWaitOf(body) : null;
  const askedSeconds = cut?.askedSeconds ?? 0;
  let legs = 1;

  while (cut) {
    const left = askedSeconds - Math.round((outcomeClock.now() - startedAt) / 1000);

    if (left <= 0) {
      if (!resumes) body = withoutHostedWait(body);

      break;
    }

    reportProgress(`Waiting on extension.dev for ${command} (${askedSeconds - left} of ${askedSeconds} s)`);
    const leg = resumes
      ? { ...call, key: crypto.randomBytes(24).toString("base64url"), sent: { ...hostedArgs(shaped, { ...(facts ?? {}), [RESUME_ACT_FACT]: true }, resource), waitSeconds: left } }
      : rereads
        ? { ...call, reads: true, key: freshKey(), sent: { ...hostedArgs(shaped, facts, resource), waitSeconds: left } }
        : { ...call, sent: { ...hostedArgs(shaped, facts, resource), waitSeconds: left } };
    const next = await askLane(leg);

    if (next.kind !== "answer") {
      if (rereads) body = endedEarly(body, Math.round((outcomeClock.now() - startedAt) / 1000), askedSeconds, legEnding(next));

      break;
    }

    const answered = takeMemory(resource, next.body);
    if (resumes && laneStatus(answered) === RESUME_UNKNOWN_STATUS) break;

    legs += 1;
    body = answered;
    cut = resumes ? (rule.resumes?.(body) === true ? hostedWaitOf(body) : null) : rereads ? (rule.rereads?.(args, body) === true ? hostedWaitOf(body) : null) : hostedWaitOf(body);
  }

  const follow = !call.reads && !resumes ? buildFollowOf(body) : null;

  if (follow) body = await followedBuild(call, follow, body, startedAt);
  else if (legs > 1) body = rereads ? withWholeFirstSubmissionWait(body, Math.round((outcomeClock.now() - startedAt) / 1000)) : withWholeWait(body, Math.round((outcomeClock.now() - startedAt) / 1000));

  body = withOneNotice(body);

  const shown = (rule.answered ? rule.answered(args, body) : body) as Args;
  const guided = (await guidedProjectConnect(command, args, shown, deps)) ?? (await guidedFirstListing(command, args, shown, deps));
  if (guided) return guided;

  const filled = await guidedListingFill(call, args, shown, deps);
  if (filled) return laneEnvelope(command, filled, deps);

  const opening = openLanePages(shown, deps);
  const retold = opening.unopened ? await retoldUnopened(call, shaped, facts, shown, opening.unopened) : null;

  return laneEnvelope(command, (retold ? ((rule.answered ? rule.answered(args, retold) : retold) as Args) : (opening.body as Args)), deps);
}

export function forwardable<T extends ToolModule>(module: T, deps: ForwarderDeps = {}): T {
  const name = module.schema.name;
  if (!FORWARDED_TOOLS[name]) return module;

  const run = module.handler;

  return {
    ...module,
    handler: (args: Args) => forwardCall(name, args, run, deps),
    approvalRecord: (args: Args) => forwardedApproval(name, args, deps),
  };
}
