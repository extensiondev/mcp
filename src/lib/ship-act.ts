// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope, type ErrorCode } from "./envelope";
import {
  APPROVAL_PENDING_STATUS,
  APPROVAL_REJECTED_STATUS,
  actionFingerprint,
  requestApprovalAfterRefusal,
  type ApprovalScope,
} from "./approval-gate";
import {
  OWNER_REQUIRED_CODE,
  openProjectApi,
  projectApiOpenFailure,
  projectApiReadFailure,
  projectApiSend,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "./project-api";

type Row = Record<string, unknown>;

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function closed(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

export interface ShipAct {
  command: string;
  act: string;
  action: string;
  route: string;
  body: Row;
  approvalId?: string;
  description: string;
  reason: string;
  stateRead: string;
  irreversible?: boolean;
  scopeFits: (scope: ApprovalScope) => boolean;
  project?: string;
  apiHint?: string;
  value?: Row;
}

const STATE_READ = "{stateRead}";

const APPROVAL_CODES: Record<string, { status: string; name: string; next: string }> = {
  APPROVAL_PENDING: { status: APPROVAL_PENDING_STATUS, name: "ApprovalPending", next: "Approve it at its URL, then call again with the same arguments and approvalId." },
  APPROVAL_DENIED: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalDenied", next: "It was denied, so nothing happened." },
  APPROVAL_EXPIRED: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalExpired", next: "Request a fresh approval by calling again with no approvalId." },
  APPROVAL_NOT_FOUND: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalUnverifiable", next: "Request a fresh approval by calling again with no approvalId." },
  APPROVAL_SCOPE_MISMATCH: {
    status: APPROVAL_REJECTED_STATUS,
    name: "ApprovalScopeMismatch",
    next: "That approval covers a different act, or what this act would do changed since it was approved; request a fresh one by calling again with no approvalId.",
  },
  APPROVAL_CONSUMED: {
    status: APPROVAL_REJECTED_STATUS,
    name: "ApprovalConsumed",
    next: `The call that used it may already have done this: read ${STATE_READ} first, and request a fresh approval only if it did not happen.`,
  },
};

const ALLOWANCE = new Set(["burst_cap", "monthly_cap", "RATE_LIMITED"]);
const UNSURE = new Set(["counter_unavailable", "entitlement_unavailable", "kill_switch", "unattributed"]);
const STORES_READ = "extension_release_status (include: [\"stores\"])";

const HINTS: Record<string, string> = {
  BUILD_DISPATCH_DISABLED: "Dispatch is paused for every project right now, so nothing ran. Try again later.",
  NO_SOURCE_REPO: "This project has no source repository connected, so there is no repository to open a pull request in. Connect one in the console's project settings.",
  UNKNOWN_CHANNEL: 'Pass one of the channels the message lists, or add this one with extension_builds (action: "create-channel") first.',
  CHANNEL_STATE_INDETERMINATE: "The platform could not read the project's channels just now. Call again in a moment.",
  NO_ROLLBACK_TARGET: "This channel has served no earlier build, so there is nothing to return to. To change what it serves, promote another build with extension_release_promote (buildId, channel).",
  ROLLBACK_HISTORY_UNREADABLE: "The platform could not read the channel's history just now, so it did not guess. Call again in a moment.",
  ROLLBACK_TARGET_MOVED: "The channel's history moved since this was asked. Call again with no approvalId for an approval of the build it would return to now.",
  RELEASE_WORKFLOW_NOT_FOUND: "The project's build repository has no release workflow. Saving the project settings in the console resyncs its workflows.",
  NO_MIRROR: "The project has no build repository yet; its first build creates one.",
  SUBMISSION_NOT_IN_REVIEW: `Only a submission the store is still reviewing can be withdrawn. Read each store's latest submission and its review state with ${STORES_READ}.`,
  SUBMISSION_NOT_FOUND: `Read the submission ids with ${STORES_READ} and pass one as submissionId.`,
  SUBMISSION_NOT_JOINABLE: `The platform cannot tie this submission to its store record, so it did not act on it. Read it with ${STORES_READ}.`,
  CANCEL_STORE_NOT_SUPPORTED: "Withdrawing a submission from review is a Chrome Web Store action here; other stores are handled in their own dashboards.",
  ROLLOUT_STORE_NOT_SUPPORTED: "A staged rollout is a Chrome Web Store feature; no other store exposes one.",
  ROLLOUT_NOT_STAGED: "Chrome publishes this project to everyone at once, so there is no rollout to raise. Staged publish is turned on in the project's Chrome store settings in the console and applies from the next submission.",
  ROLLOUT_NOT_HIGHER: 'Pass a deployPercentage above the current one; extension_release_status (include: ["rollout"]) reads it.',
  ROLLOUT_PERCENTAGE_INVALID: "Pass deployPercentage as a whole number from 1 to 100.",
  ROLLOUT_PERCENTAGE_OUT_OF_RANGE: "Pass deployPercentage as a whole number from 1 to 100; stopping a rollout is done in the Chrome Web Store dashboard.",
  CANCEL_WORKFLOW_UNSUPPORTED: "Saving the project settings in the console resyncs the build repository's workflows; then call again.",
  ROLLOUT_WORKFLOW_UNSUPPORTED: "Saving the project settings in the console resyncs the build repository's workflows; then call again.",
  VERSION_NOT_AHEAD: "Pass a version above the current one, or a level instead of a version.",
  TESTING_WORKSPACE_READ_ONLY: "This is a testing workspace, which reads but does not change anything.",
};

export function shipRefusalHint(code: string, retryAfterSeconds?: number): string | undefined {
  const wait = retryAfterSeconds ? ` The platform asks for ${retryAfterSeconds} seconds before the next try.` : "";

  if (code === "burst_cap") return `The workspace dispatched too many runs in the last hour.${wait} Nothing ran.`;
  if (code === "monthly_cap") return `The workspace's build allowance for this month is spent, so nothing ran.${wait} The plan page in the console raises it.`;
  if (code === "RATE_LIMITED") return `This login made too many of these requests.${wait}`;
  if (UNSURE.has(code)) return `The platform could not confirm this is within the workspace's allowance, so it refused instead of guessing.${wait || " Try again shortly."}`;

  return HINTS[code];
}

function refusedStatus(act: string): string {
  return `${act}-refused`;
}

function refusal(act: ShipAct, read: ProjectApiRefusal, api: ProjectApi): string {
  const body = isRow(read.body) ? read.body : {};
  const before = body.refusedBeforeApproval === true;
  const hint = shipRefusalHint(read.code, read.retryAfterSeconds);
  const ownerOnly = read.code === OWNER_REQUIRED_CODE;
  const status = ownerOnly
    ? "needs-owner"
    : read.status === 400
      ? "bad-request"
      : ALLOWANCE.has(read.code) || read.status === 429
        ? read.code === "BUILD_DISPATCH_DISABLED"
          ? "paused"
          : "rate-limited"
        : refusedStatus(act.act);
  const code: ErrorCode = status === "bad-request" ? "E_BAD_REQUEST" : read.status === 403 ? "E_AUTH_DENIED" : "E_PLATFORM";
  const spent = act.approvalId && !before;

  return envelope({
    ok: false,
    command: act.command,
    status,
    value: {
      action: act.act,
      project: `${api.ref.workspace}/${api.ref.project}`,
      ...(act.value ?? {}),
      ...(before ? { refusedBeforeApproval: true } : {}),
      ...(read.retryAfterSeconds ? { retryAfterSeconds: read.retryAfterSeconds } : {}),
    },
    error: {
      code,
      name: ownerOnly ? "OwnerRequired" : "ActRefused",
      ...(read.code ? { platformCode: read.code } : {}),
      message: before ? `${closed(read.message)} Nothing ran and no approval was requested.` : read.message,
    },
    ...(ownerOnly
      ? { hint: "Only a login approved by a workspace owner may do this. Ask an owner to sign in with extension_auth and run it, or to do it in the console." }
      : hint
        ? { hint }
        : {}),
    warnings: [spent ? `This call carried approvalId ${act.approvalId}, which the platform may have spent; read ${act.stateRead} before asking for a fresh one.` : null],
  });
}

function scopeOf(raw: unknown): ApprovalScope | null {
  if (!isRow(raw)) return null;

  const scope: ApprovalScope = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") scope[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) scope[key] = value as string[];
    else return null;
  }

  return scope;
}

/* @invariant A SHIP ACT ASKS THE PLATFORM BEFORE IT ASKS A PERSON, AND ASKS A
 * PERSON TO APPROVE ONLY WHAT THIS CALL SENT. The act route runs every
 * precondition first and answers with the approval request it would honor;
 * that request is passed on only when it names this act and a scope that
 * matches the call's own arguments, so an owner is never shown an approval
 * that could not authorize the call the agent will repeat.
 */
async function askForApproval(act: ShipAct, read: ProjectApiRefusal, api: ProjectApi): Promise<string> {
  const asked = isRow(read.body) && isRow((read.body as Row).approvalRequest) ? ((read.body as Row).approvalRequest as Row) : {};
  const scope = scopeOf(asked.scope);
  const fits =
    text(asked.action) === act.action &&
    scope !== null &&
    actionFingerprint(act.action, scope) === text(asked.fingerprint) &&
    act.scopeFits(scope);

  if (!fits || !scope) {
    return envelope({
      ok: false,
      command: act.command,
      status: refusedStatus(act.act),
      value: { action: act.act, ...(act.value ?? {}), approvalRequest: asked },
      error: {
        code: "E_PLATFORM",
        name: "ApprovalRequestMismatch",
        message: "The platform asked for an approval of something other than what this call sent, so no approval was requested and nothing ran.",
      },
    });
  }

  return requestApprovalAfterRefusal({
    command: act.command,
    action: act.action,
    scope,
    description: act.description,
    token: api.token,
    api: act.apiHint,
    refusedStatus: refusedStatus(act.act),
    refusalHint: (code) => shipRefusalHint(code),
    reason: act.reason,
    stateRead: act.stateRead,
    irreversible: act.irreversible,
  });
}

export async function openShipApi(command: string, args: { project?: string; api?: string }, value: Row): Promise<{ api: ProjectApi } | { refused: string }> {
  const opened = await openProjectApi({ command, project: args.project, api: args.api });
  if (!opened.ok) return { refused: projectApiOpenFailure(command, opened, { api: args.api, name: "Ship", value }) };

  return { api: opened.api };
}

export async function runShipAct(act: ShipAct, api: ProjectApi): Promise<{ ok: true; json: Row } | { ok: false; out: string }> {
  const approvalId = text(act.approvalId);
  const sent = await projectApiSend<Row>(api, "POST", act.route, { ...act.body, ...(approvalId ? { approvalId } : {}) });
  if (sent.ok) return { ok: true, json: isRow(sent.json) ? sent.json : {} };

  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };
  const value = { action: act.act, ...(act.value ?? {}) };

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context)) {
    return { ok: false, out: projectApiReadFailure(act.command, sent, { api: act.apiHint, name: "Ship", value, context }) };
  }

  if (!approvalId && sent.code === "APPROVAL_REQUIRED") return { ok: false, out: await askForApproval(act, sent, api) };

  const known = APPROVAL_CODES[sent.code];

  if (known) {
    return {
      ok: false,
      out: envelope({
        ok: false,
        command: act.command,
        status: known.status,
        value: { ...value, approvalId },
        error: {
          code: known.status === APPROVAL_PENDING_STATUS ? "E_APPROVAL_PENDING" : "E_APPROVAL_REJECTED",
          name: known.name,
          platformCode: sent.code,
          message: `${closed(sent.message)} Nothing was done by this call.`,
        },
        hint: known.next.replace(STATE_READ, act.stateRead),
      }),
    };
  }

  return { ok: false, out: refusal(act, sent, api) };
}

export function badShipRequest(command: string, act: string, name: string, message: string): string {
  return envelope({
    ok: false,
    command,
    status: "bad-request",
    value: { action: act },
    error: { code: "E_BAD_REQUEST", name, message },
  });
}
