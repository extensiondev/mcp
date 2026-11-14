// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { autoOpenBlock, notOpenedNote, openCommandBlock, openPagesForPerson } from "./approval-open";
import { askingOnly } from "./ask-only";
import { resolveCredential, type CredentialRef } from "./credential-source";
import { LOGIN_STEPS, NO_TOKEN_MESSAGE, noStoredLoginHint } from "./credentials";
import { envelope, isEnvelope } from "./envelope";
import { forwardSession, withForwardSession, type ForwardSession } from "./forward-approval-state";
import { approvalHeldByPerson, forgetApprovalHolders } from "./forwarded-approval";
import { forgetForwardCredential, forwardCredential, forwardUrlFor, type ExchangedCredential } from "./forward-credential";
import { ACT_SETTLE_WINDOW_MS, FORWARD_TIMEOUT_MS, IN_FLIGHT_RECHECK_MS, LOCAL_TOOLS_STILL_WORK, MEMORY_KEY, carriedMemory, hostedWaitOf, lostAnswer, readLane, takeMemory, unreadableAnswer, withWholeWait, withoutHostedWait } from "./forward-lane-answer";
import { CLOSED_STATUSES, readAnswer, readLanePreflight, withLanePreflight } from "./forward-lane-preflight";
import { expiredLoginRefusal } from "./login-expired";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { outcomeClock } from "./outcome-clock";
import { bearerFetch, unreachedBy } from "./platform-fetch";
import { PROJECT_HEADER } from "./request-fetch";
import { identityHeaders } from "./session-identity";
import { readSharedPreviews } from "./share-record";
import { forwardSubmitFacts, imagesTheLaneWants, labeledScreenshots, withProjectRoot, type ForwardFactsArgs, type WantedImage } from "./submit-facts-forward";
import { TOOL_POLICY } from "./tool-policy";

import { version as packageVersion } from "../../package.json";

import type { MintedApproval } from "./approval-state";
import type { ExpiredLogin } from "./credentials";
import type { ToolModule } from "./tool-dispatch";

type Args = Record<string, unknown>;

export const FORWARDER_HEADER = "x-extensiondev-forwarder";
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const LOCAL_FACTS_KEY = "local";
export { FORWARD_TIMEOUT_MS };
export const HOSTED_DROPPED_ARGS = ["api", "projectPath"] as const;
export const PAGE_OPENING_FACT = "pageOpening";
export const OPEN_PAGES_KEY = "openPages";
export const OPEN_PAGES_MAX = 4;

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
}

interface ForwardRule {
  reads?: (args: Args) => boolean;
  local?: (args: Args) => boolean;
  signedOut?: true;
  facts?: (args: Args, deps: ForwarderDeps, wanted: WantedImage[] | null) => Args | null | Promise<Args | null>;
  wants?: (body: Args) => WantedImage[] | null;
  sent?: (args: Args) => Args;
  answered?: (args: Args, body: unknown) => unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function actionOf(args: Args, fallback: string): string {
  return text(args.action) || fallback;
}

const SUBMIT_RULE: ForwardRule = {
  facts: async (args, deps, wanted) => ({ facts: await forwardSubmitFacts(args as ForwardFactsArgs, wanted ? { wanted } : null), [PAGE_OPENING_FACT]: { block: autoOpenBlock({ noShip: false }, deps.env ?? process.env, deps.platform) } }),
  wants: imagesTheLaneWants,
  sent: (args) => (args.screenshots === undefined ? args : { ...args, screenshots: labeledScreenshots(args as ForwardFactsArgs) }),
  answered: (args, body) => withProjectRoot(body, args.projectPath),
};

/* @invariant AN ASK-ONLY CALL REACHES THE LANE UNDER THE ASK-ONLY TOOL'S NAME,
 * OR NOT AT ALL. The asking-only mark lives in this process and does not cross
 * the wire, so a call the dispatcher runs as another tool while asking only is
 * sent as the tool the person called, and the lane's own dispatcher puts the
 * mark back before anything runs. A tool with no ask-only name runs here.
 */
function laneToolOf(command: string): string | null {
  if (!askingOnly() || TOOL_POLICY[command]?.actsAs) return command;

  return Object.keys(TOOL_POLICY).find((name) => TOOL_POLICY[name]?.actsAs?.tool === command) ?? null;
}

const reading =
  (fallback: string, ...actions: string[]) =>
  (args: Args): boolean =>
    actions.includes(actionOf(args, fallback));

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
  extension_approvals: { reads: reading("status", "status") },
  extension_release_status: { reads: (args) => !refreshes(args) },
  extension_release_promote: {},
  extension_workspace: { reads: reading("info", "info", "projects", "usage", "settings") },
  extension_shares: {
    reads: reading("list", "list"),
    local: (args) => actionOf(args, "list") === "create",
    facts: (args) => (text(args.projectPath) ? { sharedPreviews: readSharedPreviews(text(args.projectPath)) } : null),
  },
  extension_workspace_create: { local: (args) => !text(args.deviceCode), signedOut: true },
  extension_project_create: { local: (args) => !text(args.deviceCode), signedOut: true },
  extension_auth: { local: () => true },
  extension_builds: { reads: () => true, local: (args) => actionOf(args, "list") === "download" },
  extension_builds_act: {},
  extension_preview_web: { local: () => true },
  extension_publish: { local: (args) => actionOf(args, "publish") === "sync-captures" },
  extension_submit: { reads: submitReads, ...SUBMIT_RULE },
  extension_submit_check: { reads: submitReads, ...SUBMIT_RULE },
});

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

function exchangeRefusal(command: string, api: string, project: string | null, refused: Extract<ExchangedCredential, { ok: false }>): string {
  const said = refused.message ? ` (${refused.message})` : "";

  if (refused.status === 0) {
    return refusal(command, "offline", "E_NETWORK", `Platform tools need the network to reach ${api}, and this server could not reach it to exchange its device login for a forward credential${said}.`, `Try again shortly. ${LOCAL_TOOLS_STILL_WORK}`, { hosted: true });
  }

  if (refused.status === 503) {
    return refusal(command, "hosted-off", "E_PLATFORM", `extension.dev has not opened the hosted lane yet${said}.`, `Try again later. ${LOCAL_TOOLS_STILL_WORK}`, { hosted: true });
  }

  if (refused.status === 401 || refused.status === 403) {
    const login = `extension_auth (action: login${project ? `, project: "${project}"` : ""})`;

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

    return refusal(
      command,
      "forwarder-stale",
      "E_SERVER_STALE",
      text(error.message) || "This version of @extension.dev/mcp is too old for the hosted contract.",
      `Update the package first: start @extension.dev/mcp@latest in the client's MCP configuration (npx -y @extension.dev/mcp@latest), then reconnect the server (/mcp, pick extension-dev) so the new version runs. Reconnecting alone starts version ${deps.version ?? packageVersion} again. ${LOCAL_TOOLS_STILL_WORK}`,
      { hosted: true, forwarderVersion: deps.version ?? packageVersion },
    );
  }

  if (isEnvelope(body)) return JSON.stringify(body);

  const error = (body.error && typeof body.error === "object" ? body.error : {}) as Args;

  return envelope({
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

  const sentBody = JSON.stringify({ tool, args: call.sent });
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

  const value = Object.fromEntries(Object.entries(lane.value as Args).filter(([key]) => key !== OPEN_PAGES_KEY));
  const urls = named.filter(personPage).slice(0, OPEN_PAGES_MAX);
  if (!urls.length) return { body: { ...lane, value }, unopened: null };

  const env = deps.env ?? process.env;
  const blocked = autoOpenBlock({ noShip: false }, env, deps.platform);
  const opening = openPagesForPerson(urls, env, deps.platform);
  if (opening.opened) return { body: { ...lane, value }, unopened: null };

  return { body: unopenedAnswer({ ...lane, value }, opening.note), unopened: blocked ? null : openCommandBlock(deps.platform) };
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
 * preview) still runs here.
 * The lane ends every call inside its function's limit and says when it cut
 * a wait short; this process has no such limit, so a read that was cut is
 * asked again with the seconds still owed until the bound the caller asked
 * for has passed. An act is never sent twice to finish a wait: its answer
 * keeps the lane's notice and the tool's own next step. An answer that says
 * the lane is closed, and an auth status, carry what the lane's preflight
 * names as closed.
 */
export async function forwardCall(command: string, args: Args, local: (args: Args) => Promise<string>, deps: ForwarderDeps = {}): Promise<string> {
  const rule = FORWARDED_TOOLS[command];
  if (!rule || forwardSession()) return local(args);

  const tool = laneToolOf(command);
  const here = rule.local?.(args) === true;
  const named = text(args.api) || undefined;
  const checked = safeApiBase(resolveApiBase(named));

  if (!checked.ok) return here ? local(args) : refusal(command, "unavailable", "E_BAD_HOST_URL", checked.message, undefined, { hosted: true });

  const resource = forwardUrlFor(checked.base, deps.env);
  const login = (deps.resolveLogin ?? resolveCredential)({ project: text(args.project) || undefined, api: named });

  if (!login.token) return here || rule.signedOut ? local(args) : signedOutRefusal(command, args, login, named);
  if (!tool) return here ? local(args) : askOnlyRefusal(command);

  if (!resource) {
    if (here) return local(args);

    return refusal(
      command,
      "hosted-unpaired",
      "E_TOOL_DISABLED",
      `${checked.base} has no hosted lane paired with it, so no login was sent.`,
      `Platform tools run on the hosted lane paired with https://www.extension.dev, or with a loopback www for development. Point api (or EXTENSION_DEV_API_URL) at one of them. ${LOCAL_TOOLS_STILL_WORK}`,
      { hosted: true },
    );
  }

  const session: ForwardSession = { api: checked.base, login: login.token, project: refOf(login.ref), resource, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  const answer = here ? await withForwardSession(session, () => local(args)) : await forwardedAnswer({ command, tool, rule, args, session }, local, deps);
  const answered = readAnswer(answer);
  const closed = CLOSED_STATUSES.includes(text(answered?.status));
  if (!answered || (!closed && !(command === "extension_auth" && actionOf(args, "status") === "status"))) return answer;

  const read = await readLanePreflight(resource, deps.version ?? packageVersion, deps.fetchImpl);

  return read ? JSON.stringify(withLanePreflight(answered, resource, read, closed || read.closed.length > 0)) : answer;
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

  return envelope({
    ok: false,
    command,
    status: "auth-required",
    value: { hosted: true },
    error: { code: "E_AUTH_REQUIRED", name: "PlatformAuthError", message: project ? noStoredLoginHint(project) : (login.note ?? NO_TOKEN_MESSAGE) },
    hint: LOGIN_STEPS,
  });
}

function askOnlyRefusal(command: string): string {
  return refusal(command, "ask-only", "E_TOOL_DISABLED", `${command} was called while only asking, and it has no ask-only form on the hosted lane, so nothing was sent.`, `Call ${command} itself to run it.`, { hosted: true });
}

async function forwardedAnswer(asked: { command: string; tool: string; rule: ForwardRule; args: Args; session: ForwardSession }, local: (args: Args) => Promise<string>, deps: ForwarderDeps): Promise<string> {
  const { command, tool, rule, args, session } = asked;
  const resource = session.resource;
  let facts = (await rule.facts?.(args, deps, null)) ?? null;
  const shaped = rule.sent?.(args) ?? args;
  let call: LaneCall = { command, tool, session, sent: hostedArgs(shaped, facts, resource), key: crypto.randomBytes(24).toString("base64url"), reads: rule.reads?.(args) === true, deps };
  const startedAt = outcomeClock.now();
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

  let cut = call.reads ? hostedWaitOf(body) : null;
  const askedSeconds = cut?.askedSeconds ?? 0;
  let legs = 1;

  while (cut) {
    const left = askedSeconds - Math.round((outcomeClock.now() - startedAt) / 1000);

    if (left <= 0) {
      body = withoutHostedWait(body);
      break;
    }

    const next = await askLane({ ...call, sent: { ...hostedArgs(shaped, facts, resource), waitSeconds: left } });
    if (next.kind !== "answer") break;

    legs += 1;
    body = takeMemory(resource, next.body);
    cut = hostedWaitOf(body);
  }

  if (legs > 1) body = withWholeWait(body, Math.round((outcomeClock.now() - startedAt) / 1000));

  const shown = (rule.answered ? rule.answered(args, body) : body) as Args;
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
