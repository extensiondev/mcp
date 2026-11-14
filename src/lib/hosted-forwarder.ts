// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { storedLoginFor } from "./approval-login";
import { autoOpenBlock, notOpenedNote, openCommandBlock, openPagesForPerson } from "./approval-open";
import { mintedApproval } from "./approval-record";
import { targetServer } from "./credential-server";
import { askingOnly } from "./ask-only";
import { resolveCredential, type CredentialRef } from "./credential-source";
import { MEMBER_PROJECT, listCredentials } from "./credentials";
import { envelope, isEnvelope } from "./envelope";
import { forwardSession, withForwardSession, wwwApprovalState, type ForwardSession } from "./forward-approval-state";
import { HOSTED_SWITCH, forgetForwardCredential, forwardCredential, forwardUrlFor, hostedForwarding, type ExchangedCredential } from "./forward-credential";
import { ACT_SETTLE_WINDOW_MS, FORWARD_TIMEOUT_MS, IN_FLIGHT_RECHECK_MS, MEMORY_KEY, carriedMemory, hostedWaitOf, lostAnswer, readLane, takeMemory, unreadableAnswer, withWholeWait, withoutHostedWait } from "./forward-lane-answer";
import { CLOSED_STATUSES, readAnswer, readLanePreflight, withLanePreflight } from "./forward-lane-preflight";
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

interface StoredLogin {
  token: string;
  ref: CredentialRef | null;
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

export const FORWARDED_TOOLS: Readonly<Record<string, ForwardRule>> = Object.freeze({
  extension_approvals: { reads: reading("status", "status") },
  extension_release_status: { reads: () => true },
  extension_release_promote: {},
  extension_workspace: { reads: reading("info", "info", "projects", "usage", "settings") },
  extension_shares: {
    reads: reading("list", "list"),
    local: (args) => actionOf(args, "list") === "create",
    facts: (args) => (text(args.projectPath) ? { sharedPreviews: readSharedPreviews(text(args.projectPath)) } : null),
  },
  extension_workspace_create: { local: (args) => !text(args.deviceCode) },
  extension_project_create: { local: (args) => !text(args.deviceCode) },
  extension_auth: { local: () => true },
  extension_builds: { reads: reading("list", "list", "get", "logs"), local: (args) => actionOf(args, "list") === "download" },
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
  const local = `Unset ${HOSTED_SWITCH} to run ${command} in this process, as the default does.`;

  if (refused.status === 0) {
    return refusal(command, "offline", "E_NETWORK", `Platform tools need the network to reach ${api}, and this server could not reach it to exchange its device login for a forward credential${said}. The local tools still work.`, `Try again shortly. ${local}`, { hosted: true });
  }

  if (refused.status === 503) {
    return refusal(command, "hosted-off", "E_PLATFORM", `extension.dev has not opened the hosted lane yet${said}.`, local, { hosted: true });
  }

  if (refused.status === 401 || refused.status === 403) {
    const login = `extension_auth (action: login${project ? `, project: "${project}"` : ""})`;

    return refusal(command, "auth-refused", "E_AUTH_DENIED", `extension.dev refused to exchange the stored login${project ? ` for ${project}` : ""} for a forward credential${said}.`, `Run ${login} on this machine to sign in again, then call ${command} again.`, { hosted: true });
  }

  return refusal(command, refused.status === 429 ? "rate-limited" : "platform-unavailable", "E_PLATFORM", `extension.dev could not mint a forward credential just now${said}.`, `Try again shortly. ${local}`, { hosted: true });
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
      `Update the package first: start @extension.dev/mcp@latest in the client's MCP configuration (npx -y @extension.dev/mcp@latest), then reconnect the server (/mcp, pick extension-dev) so the new version runs. Reconnecting alone starts version ${deps.version ?? packageVersion} again. Unset ${HOSTED_SWITCH} to run ${command} in this process meanwhile.`,
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

function storedLogins(api?: string): StoredLogin[] {
  const server = targetServer(api);
  const now = Math.floor(Date.now() / 1000);

  try {
    return listCredentials()
      .filter((entry) => entry.server === server && !entry.movedTo && entry.projectSlug !== MEMBER_PROJECT && !(entry.expiresAt && entry.expiresAt <= now))
      .map((entry) => ({ token: String(entry.token).trim(), ref: { workspace: entry.workspaceSlug, project: entry.projectSlug } }));
  } catch {
    return [];
  }
}

const approvalHolders = new Map<string, string>();

export function forgetApprovalHolders(): void {
  approvalHolders.clear();
}

/* @invariant A FORWARDED CALL THAT CARRIES AN APPROVAL ID IS MADE AS THE
 * PROJECT AND WITH THE LOGIN THE APPROVAL WAS MINTED FOR, WHEREVER ITS RECORD
 * LIVES. On the forwarder path the record is in www's hosted state, not in
 * this machine's approvals.json, and www answers it only to a credential of
 * the project that minted it. So the login the call would use is asked
 * first, then the other logins stored for that server, one at a time, the
 * same workspace before the rest, each with the forward credential this
 * process already holds for it, and the asking stops at the first that
 * reads the record. A member login is asked once per project it lists, on
 * one exchange. Which login read an id is remembered for as long as this
 * server runs, so the status poll and the act that follow cost one read
 * each. The record is handed to the dispatcher, which binds the project and
 * the login exactly as it does for a record on disk (ledger 443 and 472). A
 * record this machine holds on disk is left to the dispatcher's own read; an
 * id no stored login can read is left to the platform, and so is a record
 * read by a login that is not in the store (EXTENSION_DEV_TOKEN), because
 * that call already goes out with the login www answered.
 */
export async function forwardedApproval(command: string, args: Args, deps: ForwarderDeps = {}): Promise<MintedApproval | null> {
  const approvalId = text(args.approvalId);
  if (!FORWARDED_TOOLS[command] || !approvalId) return null;

  const named = text(args.api) || undefined;
  if (mintedApproval(named, approvalId)) return null;

  const checked = safeApiBase(resolveApiBase(named));
  const resource = checked.ok ? forwardUrlFor(checked.base, deps.env) : null;
  if (!checked.ok || !resource) return null;

  const own = (deps.resolveLogin ?? resolveCredential)({ project: text(args.project) || undefined, api: named });
  const keyOf = (login: StoredLogin): string => `${login.token} ${refOf(login.ref) ?? ""}`;
  const held = `${checked.base} ${approvalId}`;
  const rank = (login: StoredLogin): number => (keyOf(login) === approvalHolders.get(held) ? 0 : login === own ? 1 : login.ref?.workspace.toLowerCase() === own.ref?.workspace.toLowerCase() ? 2 : 3);
  const known = new Set<string>();
  const logins = [own, ...(deps.storedLogins ?? storedLogins)(named)]
    .filter((login) => {
      if (!login.token || known.has(keyOf(login))) return false;

      known.add(keyOf(login));

      return true;
    })
    .sort((a, b) => rank(a) - rank(b));

  for (const login of logins) {
    const found = await wwwApprovalState({ api: checked.base, login: login.token, project: refOf(login.ref), resource, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }).mintedApproval(checked.base, approvalId);
    if (!found) continue;

    approvalHolders.set(held, keyOf(login));

    return login === own && !storedLoginFor(found, named) ? null : found;
  }

  return null;
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

/* @invariant THE FORWARDER SENDS THE HOSTED LANE A PROJECT REF, NEVER A PATH,
 * AND ONE ACT ONE KEY. The stored login is resolved here, exchanged at its own
 * www for a forward credential, and only that credential reaches the lane;
 * api and projectPath stay on this machine, and what the hosted half needs
 * from the project (the STORE.md, icon, screenshot and git facts of a submit,
 * the share record of a list or revoke) is read here and sent as facts, with
 * image bytes uploaded from here to www and the project root sent as a label.
 * Each call carries one idempotency key, and the forwarder's own retry (a
 * refused cached credential, a lane that did not answer) sends the same key, so
 * the lane answers the first outcome instead of acting twice. A step that writes
 * to this machine or starts a device login runs here, never on the lane, and
 * with no stored login the whole call runs here, as the default path does.
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
  const tool = laneToolOf(command);
  if (!rule || !tool || forwardSession()) return local(args);

  const named = text(args.api) || undefined;
  const checked = safeApiBase(resolveApiBase(named));
  if (!checked.ok) return local(args);

  const resource = forwardUrlFor(checked.base, deps.env);

  if (!resource) {
    return refusal(
      command,
      "hosted-unpaired",
      "E_TOOL_DISABLED",
      `${HOSTED_SWITCH} is on, but ${checked.base} has no hosted lane paired with it, so no login was sent.`,
      `Unset ${HOSTED_SWITCH} to run ${command} in this process. Only https://www.extension.dev and a loopback www have a hosted lane.`,
      { hosted: true },
    );
  }

  const answer = await forwardedAnswer({ command, tool, rule, args, api: checked.base, resource }, local, deps);
  const answered = readAnswer(answer);
  const closed = CLOSED_STATUSES.includes(text(answered?.status));
  if (!answered || (!closed && !(command === "extension_auth" && actionOf(args, "status") === "status"))) return answer;

  const read = await readLanePreflight(resource, deps.version ?? packageVersion, deps.fetchImpl);

  return read ? JSON.stringify(withLanePreflight(answered, resource, read, closed || read.closed.length > 0)) : answer;
}

async function forwardedAnswer(asked: { command: string; tool: string; rule: ForwardRule; args: Args; api: string; resource: string }, local: (args: Args) => Promise<string>, deps: ForwarderDeps): Promise<string> {
  const { command, tool, rule, args, resource } = asked;
  const login = (deps.resolveLogin ?? resolveCredential)({ project: text(args.project) || undefined, api: text(args.api) || undefined });
  if (!login.token) return local(args);

  const session: ForwardSession = { api: asked.api, login: login.token, project: refOf(login.ref), resource, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };

  if (rule.local?.(args)) return withForwardSession(session, () => local(args));

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
    handler: (args: Args) => (hostedForwarding(deps.env) ? forwardCall(name, args, run, deps) : run(args)),
    approvalRecord: async (args: Args) => (hostedForwarding(deps.env) ? forwardedApproval(name, args, deps) : null),
  };
}
