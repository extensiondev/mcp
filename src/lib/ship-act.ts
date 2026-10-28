// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { approvalRoundTrip } from "./approval-outcome";
import { envelope, type ErrorCode } from "./envelope";
import {
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

/* @invariant A REFUSED DISPATCH THAT GAVE THE GRANT BACK IS A RETRY, NOT A
 * FRESH ASK. The platform answers approvalRefunded true only when it proved
 * nothing ran and deleted the grant's used marker, so the same approvalId
 * spends once more; asking the owner again would be the second click day two
 * paid for. The next step says so to the person and the hint to the agent.
 */
export const REFUNDED_SAY =
  "The platform could not start it, so nothing ran and your approval still stands. Say try again and I run it again with the same approval.";

export const REFUNDED_STEP = { kind: "retry", say: REFUNDED_SAY, url: null } as const;

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
  RELEASE_WORKFLOW_NOT_FOUND: "The platform has no release setup for this project yet. Saving the project settings in the console sets it up again.",
  NO_MIRROR: "The project is not set up for releases yet; its first build sets it up.",
  SUBMISSION_NOT_IN_REVIEW: `Only a submission the store is still reviewing can be withdrawn. Read each store's latest submission and its review state with ${STORES_READ}.`,
  SUBMISSION_NOT_FOUND: `Read the submission ids with ${STORES_READ} and pass one as submissionId.`,
  SUBMISSION_NOT_JOINABLE: `The platform cannot tie this submission to its store record, so it did not act on it. Read it with ${STORES_READ}.`,
  CANCEL_STORE_NOT_SUPPORTED: "Withdrawing a submission from review is offered here for the Chrome Web Store and for Safari's App Review; Firefox and Edge withdrawals are handled in their own dashboards.",
  ROLLOUT_STORE_NOT_SUPPORTED: "A staged rollout is a Chrome Web Store feature; no other store exposes one.",
  ROLLOUT_NOT_STAGED: "Chrome publishes this project to everyone at once, so there is no rollout to raise. Staged publish is turned on in the project's Chrome store settings in the console and applies from the next submission.",
  ROLLOUT_NOT_HIGHER: 'Pass a deployPercentage above the current one; extension_release_status (include: ["rollout"]) reads it.',
  ROLLOUT_PERCENTAGE_INVALID: "Pass deployPercentage as a whole number from 1 to 100.",
  ROLLOUT_PERCENTAGE_OUT_OF_RANGE: "Pass deployPercentage as a whole number from 1 to 100; stopping a rollout is done in the Chrome Web Store dashboard.",
  CANCEL_WORKFLOW_UNSUPPORTED: "Saving the project settings in the console brings the project's platform setup up to date; then call again.",
  ROLLOUT_WORKFLOW_UNSUPPORTED: "Saving the project settings in the console brings the project's platform setup up to date; then call again.",
  PUBLISH_WORKFLOW_UNSUPPORTED: "Saving the project settings in the console brings the project's platform setup up to date; then call again.",
  SAFARI_NEWER_BUILD: `A newer Safari TestFlight build is a draft, so the older build was not sent and no approval was spent. Call publish with no submissionId, or with newerSubmissionId, so the approval names the newer build; ${STORES_READ} lists both.`,
  SAFARI_NEWER_BUILD_UNREAD: `A newer Safari build's run failed after its upload, and the platform asked the project's store poller to read that build back from App Store Connect, so nothing was sent and no approval was requested. Call publish again in a few minutes; ${STORES_READ} shows the newer submission once it reads draft.`,
  SAFARI_BUILD_NOT_FOUND: `No Safari submission carries the TestFlight build number named, so nothing was sent and no approval was requested; value.knownBuildNumbers lists the builds on record. Call publish with one of them, or with no buildNumber to send the newest; ${STORES_READ} shows each submission's build.`,
  SAFARI_BUILD_NUMBER_INVALID: "buildNumber is the TestFlight build number Apple shows, a whole number above zero. Nothing was sent.",
  SAFARI_VERSION_IN_REVIEW: `Apple holds another App Store version of this app for review and creates no other version meanwhile, so the draft was not sent and no approval was spent. Withdraw that version with extension_submit {action: "cancel", store: "safari", submissionId: value.heldSubmissionId} once a workspace owner approves it, then call publish again; ${STORES_READ} shows the held version.`,
  PUBLISH_STORE_NOT_SUPPORTED: "Sending a draft to review is a Chrome Web Store act here; the other stores enter review when they are submitted.",
  PUBLISH_IN_FLIGHT: `The publish you asked for is already on its way and nothing was dispatched again. Read the record with ${STORES_READ}, or call extension_submit {action: "status"} when it exists, and never send the draft again while it is on its way.`,
  CANCEL_IN_FLIGHT: `The withdrawal you asked for is already on its way and nothing was dispatched again. Read the record with ${STORES_READ} before asking again.`,
  SUBMISSION_NOT_CANCELLABLE: `The store holds no review to withdraw for this submission; the platform read the store's current state before asking anyone to approve. ${STORES_READ} reads the record it settled.`,
  REVIEW_RECORD_STALE: `The store's last answer about this submission is older than a day and the platform could not read the store for this project from here, so it asked the project's poller instead of withdrawing on a stale record. Read the submission again in a few minutes with ${STORES_READ}, then call again.`,
  VERSION_NOT_AHEAD: "Pass a version above the current one, or a level instead of a version.",
  TESTING_WORKSPACE_READ_ONLY: "This is a testing workspace, which reads but does not change anything.",
};

const STORE_DRAFT_LABELS: Record<string, string> = { chrome: "Chrome", edge: "Edge", safari: "Safari" };

/* @invariant A STORE REFUSAL HINT NAMES THE STORE OF THE CALL. Rebeccat's
 * Safari publish of 2026-10-28 was answered "Only a Chrome draft can be sent
 * to review" for a Safari submission, because the hint table was written when
 * Chrome was the only store with a draft act. The draft hints are written for
 * the store the act named, and a call that names none keeps Chrome.
 */
function storeDraftHint(code: string, store: string): string | undefined {
  const label = STORE_DRAFT_LABELS[store] ?? STORE_DRAFT_LABELS.chrome!;
  const browser = STORE_DRAFT_LABELS[store] ? store : "chrome";
  const article = /^[aeiou]/i.test(label) ? "an" : "a";

  if (code === "SUBMISSION_NOT_DRAFT") {
    return `Only ${article} ${label} draft can be sent to review. Read each submission's state with ${STORES_READ}, or call publish with no submissionId to send the newest draft.`;
  }

  if (code === "NO_CHROME_DRAFT") {
    return `There is no ${label} draft to send yet. Submit a build with extension_submit (browsers: ["${browser}"], dryRun: false); it lands as ${browser === "safari" ? "a TestFlight draft" : "a draft"}, and publish sends that draft to review.`;
  }

  return undefined;
}

export function shipRefusalHint(code: string, retryAfterSeconds?: number, store = ""): string | undefined {
  const wait = retryAfterSeconds ? ` The platform asks for ${retryAfterSeconds} seconds before the next try.` : "";
  const drafted = storeDraftHint(code, store);

  if (drafted) return drafted;

  if (code === "burst_cap") return `The workspace dispatched too many runs in the last hour.${wait} Nothing ran.`;
  if (code === "monthly_cap") return `The workspace's build allowance for this month is spent, so nothing ran.${wait} The plan page in the console raises it.`;
  if (code === "RATE_LIMITED") return `This login made too many of these requests.${wait}`;
  if (UNSURE.has(code)) return `The platform could not confirm this is within the workspace's allowance, so it refused instead of guessing.${wait || " Try again shortly."}`;

  return HINTS[code];
}

const STATE_CODES: Record<string, string> = {
  SUBMISSION_NOT_CANCELLABLE: "store-not-reviewing",
  REVIEW_RECORD_STALE: "review-record-stale",
};

function refusedStatus(act: string): string {
  return `${act}-refused`;
}

/* @invariant THE STORE'S CURRENT STATE IS ANSWERED AS A STATE, WITH NO
 * APPROVAL ASKED. The platform re-polls a day-old review before it mints an
 * approval, and its refusal carries the state it read and when; the answer
 * carries the same and says it in one sentence, so an owner is never asked
 * to approve withdrawing a review the store already ended.
 */
function storeStateFields(code: string, body: Row): Row {
  const status = STATE_CODES[code];
  if (!status) return {};

  const state = text(body.state);
  const checkedAt = text(body.checkedAt);
  const visibility = text(body.visibility);
  const say =
    code === "SUBMISSION_NOT_CANCELLABLE"
      ? `The Chrome Web Store says ${state || "there is no active submission"}${visibility ? ` (${visibility})` : ""}${checkedAt ? `, read ${checkedAt}` : ""}, so there is no review to withdraw and no approval was requested. Say status to read the record.`
      : `The store's last answer about this submission${state ? ` (${state}${checkedAt ? `, ${checkedAt}` : ""})` : ""} is older than a day and the platform could not read the store from here, so it asked the project's poller and withdrew nothing; no approval was requested. Say status again in a few minutes.`;

  return {
    ...(state ? { state } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(visibility ? { visibility } : {}),
    ...(text(body.recordStatus) ? { recordStatus: text(body.recordStatus) } : {}),
    sayToPerson: say,
  };
}

function refusal(act: ShipAct, read: ProjectApiRefusal, api: ProjectApi): string {
  const body = isRow(read.body) ? read.body : {};
  const before = body.refusedBeforeApproval === true;
  const hint = shipRefusalHint(read.code, read.retryAfterSeconds, text(act.value?.store));
  const ownerOnly = read.code === OWNER_REQUIRED_CODE;
  const status = ownerOnly
    ? "needs-owner"
    : STATE_CODES[read.code]
      ? STATE_CODES[read.code]
      : read.status === 400
      ? "bad-request"
      : ALLOWANCE.has(read.code) || read.status === 429
        ? read.code === "BUILD_DISPATCH_DISABLED"
          ? "paused"
          : "rate-limited"
        : refusedStatus(act.act);
  const code: ErrorCode = status === "bad-request" ? "E_BAD_REQUEST" : read.status === 403 ? "E_AUTH_DENIED" : "E_PLATFORM";
  const refunded = Boolean(act.approvalId) && body.approvalRefunded === true;
  const spent = act.approvalId && !before && !refunded;

  return envelope({
    ok: false,
    command: act.command,
    status,
    value: {
      action: act.act,
      project: `${api.ref.workspace}/${api.ref.project}`,
      ...(act.value ?? {}),
      ...(before ? { refusedBeforeApproval: true } : {}),
      ...(read.code === "LISTING_INCOMPLETE" ? { listingIncomplete: body } : {}),
      ...storeStateFields(read.code, body),
      ...(text(body.uploadRunState)
        ? {
            uploadRunState: text(body.uploadRunState),
            ...(text(body.submissionId) ? { submissionId: text(body.submissionId) } : {}),
            ...(text(body.buildId) ? { buildId: text(body.buildId) } : {}),
          }
        : {}),
      ...(text(body.newerSubmissionId)
        ? {
            newerSubmissionId: text(body.newerSubmissionId),
            ...(text(body.newerBuildNumber) ? { newerBuildNumber: Number(text(body.newerBuildNumber)) } : {}),
            ...(body.refreshRequested === true ? { refreshRequested: true } : {}),
          }
        : {}),
      ...(read.code === "SAFARI_BUILD_NOT_FOUND"
        ? {
            ...(text(body.buildNumber) ? { buildNumber: Number(text(body.buildNumber)) } : {}),
            ...(Array.isArray(body.knownBuildNumbers) ? { knownBuildNumbers: body.knownBuildNumbers } : {}),
            ...(text(body.submissionId) ? { submissionId: text(body.submissionId) } : {}),
          }
        : {}),
      ...(read.retryAfterSeconds ? { retryAfterSeconds: read.retryAfterSeconds } : {}),
      ...(refunded ? { approvalId: act.approvalId, approvalRefunded: true, sayToPerson: REFUNDED_SAY, nextStep: REFUNDED_STEP } : {}),
    },
    error: {
      code,
      name: ownerOnly ? "OwnerRequired" : "ActRefused",
      ...(read.code ? { platformCode: read.code } : {}),
      message: before ? `${closed(read.message)} Nothing ran and no approval was requested.` : read.message,
    },
    ...(ownerOnly
      ? { hint: "Only a login approved by a workspace owner may do this. Ask an owner to sign in with extension_auth and run it, or to do it in the console." }
      : refunded
        ? { hint: `${hint ? `${hint} ` : ""}Nothing ran and the approval was not spent: call again with the same arguments and approvalId ${act.approvalId}.` }
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
    refusalHint: (code) => shipRefusalHint(code, undefined, text(act.value?.store)),
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

  const answered = approvalRoundTrip({
    command: act.command,
    platformCode: sent.code,
    message: sent.message,
    approvalId,
    undone: "Nothing was done by this call.",
    api: act.apiHint,
    value,
    stateRead: act.stateRead,
    retryAfterSeconds: sent.retryAfterSeconds,
  });

  if (answered) return { ok: false, out: answered };

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
