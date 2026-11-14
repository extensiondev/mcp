// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { resolveCredential, type CredentialRef } from "./credential-source";
import { envelope, isEnvelope } from "./envelope";
import { forwardSession, withForwardSession, type ForwardSession } from "./forward-approval-state";
import { HOSTED_SWITCH, forgetForwardCredential, forwardCredential, forwardUrlFor, hostedForwarding, type ExchangedCredential } from "./forward-credential";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { bearerFetch } from "./platform-fetch";
import { PROJECT_HEADER } from "./request-fetch";
import { readSharedPreviews } from "./share-record";
import { readSubmitFacts, type SubmitFactsArgs } from "./submit-facts-local";

import { version as packageVersion } from "../../package.json";

import type { ToolModule } from "./tool-dispatch";

type Args = Record<string, unknown>;

export const FORWARDER_HEADER = "x-extensiondev-forwarder";
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const LOCAL_FACTS_KEY = "local";
export const FORWARD_TIMEOUT_MS = 60_000;
export const HOSTED_DROPPED_ARGS = ["api", "projectPath"] as const;

interface ForwardRule {
  local?: (args: Args) => boolean;
  facts?: (args: Args) => Args | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function actionOf(args: Args, fallback: string): string {
  return text(args.action) || fallback;
}

function submitFacts(args: Args): Args {
  return { facts: readSubmitFacts(args as SubmitFactsArgs) };
}

export const FORWARDED_TOOLS: Readonly<Record<string, ForwardRule>> = Object.freeze({
  extension_approvals: {},
  extension_release_status: {},
  extension_release_promote: {},
  extension_workspace: {},
  extension_shares: {
    local: (args) => actionOf(args, "list") === "create",
    facts: (args) => (text(args.projectPath) ? { sharedPreviews: readSharedPreviews(text(args.projectPath)) } : null),
  },
  extension_workspace_create: { local: (args) => !text(args.deviceCode) },
  extension_project_create: { local: (args) => !text(args.deviceCode) },
  extension_auth: { local: (args) => actionOf(args, "status") !== "status" },
  extension_builds: { local: (args) => actionOf(args, "list") === "download" },
  extension_preview_web: { local: () => true },
  extension_publish: { local: (args) => actionOf(args, "publish") === "sync-captures" },
  extension_submit: { facts: submitFacts },
  extension_submit_check: { facts: submitFacts },
});

export interface ForwarderDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  version?: string;
  resolveLogin?: (options: { project?: string; api?: string }) => { token: string; ref: CredentialRef | null };
}

type LaneAnswer = { kind: "answer"; body: unknown } | { kind: "refused"; text: string } | { kind: "retry"; text: string; fresh: boolean };

function refusal(command: string, status: string, code: string, message: string, hint?: string, value?: Args): string {
  return envelope({ ok: false, command, status, error: { code, message }, ...(hint ? { hint } : {}), ...(value ? { value } : {}) });
}

function exchangeRefusal(command: string, api: string, project: string | null, refused: Extract<ExchangedCredential, { ok: false }>): string {
  const said = refused.message ? ` (${refused.message})` : "";
  const local = `Unset ${HOSTED_SWITCH} to run ${command} in this process, as the default does.`;

  if (refused.status === 0) {
    return refusal(command, "platform-unreachable", "E_PLATFORM", `The local server could not reach ${api} to exchange its device login for a forward credential${said}.`, `Try again shortly. ${local}`, { hosted: true });
  }

  if (refused.status === 503) {
    return refusal(command, "hosted-off", "E_TOOL_DISABLED", `extension.dev has not opened the hosted lane yet${said}.`, local, { hosted: true });
  }

  if (refused.status === 401 || refused.status === 403) {
    const login = `extension_auth (action: login${project ? `, project: "${project}"` : ""})`;

    return refusal(command, "auth-refused", "E_AUTH_DENIED", `extension.dev refused to exchange the stored login${project ? ` for ${project}` : ""} for a forward credential${said}.`, `Run ${login} on this machine to sign in again, then call ${command} again.`, { hosted: true });
  }

  return refusal(command, refused.status === 429 ? "rate-limited" : "platform-unavailable", "E_PLATFORM", `extension.dev could not mint a forward credential just now${said}.`, `Try again shortly. ${local}`, { hosted: true });
}

function laneEnvelope(command: string, body: unknown): string {
  if (isEnvelope(body)) return JSON.stringify(body);

  const lane = (body && typeof body === "object" ? body : {}) as Args;
  const error = (lane.error && typeof lane.error === "object" ? lane.error : {}) as Args;

  return envelope({
    ok: lane.ok === true,
    command,
    status: text(lane.status) || "platform-unavailable",
    ...(lane.ok === true ? {} : { error: { code: text(error.code) || "E_PLATFORM", message: text(error.message) || "The hosted lane answered nothing this server could read." } }),
    ...(text(lane.hint) ? { hint: text(lane.hint) } : {}),
    ...(lane.value && typeof lane.value === "object" ? { value: lane.value } : {}),
  });
}

function laneStatus(body: unknown): string {
  return body && typeof body === "object" ? text((body as Args).status) : "";
}

function laneCode(body: unknown): string {
  const error = body && typeof body === "object" ? (body as Args).error : null;

  return error && typeof error === "object" ? text((error as Args).code) : "";
}

async function sendOnce(
  command: string,
  session: ForwardSession,
  sent: Args,
  key: string,
  deps: ForwarderDeps,
  fresh: boolean,
): Promise<LaneAnswer> {
  const exchanged = await forwardCredential({ ...session, fresh });
  if (!exchanged.ok) return { kind: "refused", text: exchangeRefusal(command, session.api, session.project, exchanged) };

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
        },
        body: JSON.stringify({ tool: command, args: sent }),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      },
      deps.fetchImpl,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    return {
      kind: "retry",
      fresh: false,
      text: refusal(command, "platform-unreachable", "E_PLATFORM", `The hosted lane at ${session.resource} did not answer (${reason}).`, `The act may have run: read its record (extension_release_status, or extension_submit_check action:'status') before calling again. Unset ${HOSTED_SWITCH} to run ${command} in this process.`, { hosted: true, idempotencyKey: key }),
    };
  }

  const body: unknown = await res.json().catch(() => null);

  if (laneCode(body) === "E_AUTH_DENIED" && exchanged.cached) {
    forgetForwardCredential(session);

    return { kind: "retry", fresh: true, text: laneEnvelope(command, body) };
  }

  return { kind: "answer", body };
}

function hostedArgs(args: Args, facts: Args | null): Args {
  const kept = Object.fromEntries(Object.entries(args).filter(([key]) => !(HOSTED_DROPPED_ARGS as readonly string[]).includes(key) && key !== LOCAL_FACTS_KEY));

  return facts ? { ...kept, [LOCAL_FACTS_KEY]: facts } : kept;
}

function refOf(ref: CredentialRef | null): string | null {
  return ref ? `${ref.workspace}/${ref.project}`.toLowerCase() : null;
}

/* @invariant THE FORWARDER SENDS THE HOSTED LANE A PROJECT REF, NEVER A PATH,
 * AND ONE ACT ONE KEY. The stored login is resolved here, exchanged at its own
 * www for a forward credential, and only that credential reaches the lane;
 * api and projectPath stay on this machine, and what the hosted half needs
 * from the project (the STORE.md, icon, screenshot and git facts of a submit,
 * the share record of a list or revoke) is read here and sent as facts. Each
 * call carries one idempotency key, and the forwarder's own retry (a refused
 * cached credential, a lane that did not answer) sends the same key, so the
 * lane answers the first outcome instead of acting twice. A step that writes
 * to this machine or starts a device login runs here, never on the lane, and
 * with no stored login the whole call runs here, as the default path does.
 */
export async function forwardCall(command: string, args: Args, local: (args: Args) => Promise<string>, deps: ForwarderDeps = {}): Promise<string> {
  const rule = FORWARDED_TOOLS[command];
  if (!rule || forwardSession()) return local(args);

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

  const login = (deps.resolveLogin ?? resolveCredential)({ project: text(args.project) || undefined, api: named });
  if (!login.token) return local(args);

  const session: ForwardSession = { api: checked.base, login: login.token, project: refOf(login.ref), resource, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };

  if (rule.local?.(args)) return withForwardSession(session, () => local(args));

  const sent = hostedArgs(args, rule.facts?.(args) ?? null);
  const key = crypto.randomBytes(24).toString("base64url");
  let answer = await sendOnce(command, session, sent, key, deps, false);

  if (answer.kind === "retry") answer = await sendOnce(command, session, sent, key, deps, answer.fresh);
  if (answer.kind !== "answer") return answer.text;
  if (laneStatus(answer.body) === "local-half") return withForwardSession(session, () => local(args));

  return laneEnvelope(command, answer.body);
}

export function forwardable<T extends ToolModule>(module: T, deps: ForwarderDeps = {}): T {
  const name = module.schema.name;
  if (!FORWARDED_TOOLS[name]) return module;

  const run = module.handler;

  return { ...module, handler: (args: Args) => (hostedForwarding(deps.env) ? forwardCall(name, args, run, deps) : run(args)) };
}
