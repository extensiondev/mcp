// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveCredential } from "./credential-source";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { missedRead, type RecordRead } from "./act-outcome";
import { platformFetch } from "./platform-fetch";
import { platformApiGet, type ProjectApi } from "./project-api";
import { identityHeaders } from "./session-identity";

export const RETRIED_SENTENCE = "GitHub canceled the run before upload; the platform started it again.";

export interface SubmissionRun {
  status?: string;
  conclusion?: string;
  url?: string;
  outcome?: string;
  storeReached?: boolean | null;
  failedStep?: string;
  message?: string;
  settled?: boolean;
}

export interface StoreReview {
  state: string;
  checkedAt?: string;
  source?: string;
  visibility?: string;
  crxVersion?: string;
  liveState?: string;
}

export interface StoreAct {
  act: string;
  status: string;
  storeMessage?: string;
  at?: string;
}

export interface SubmissionDispatch {
  action?: string;
  dispatchedAt?: string;
  runState: string;
  failedStep?: string;
  failedReason?: string;
  refunded: boolean;
}

export interface StoreUpload {
  state: string;
  crxVersion?: string;
  checkedAt?: string;
}

export interface StepFailure {
  step: string;
}

export interface PlatformSubmission {
  id?: string;
  store: string;
  status?: string;
  rawStatus?: string;
  cancel?: StoreAct;
  publish?: StoreAct;
  dispatch?: SubmissionDispatch;
  version?: string;
  buildSha?: string;
  channel?: string;
  submittedAt?: string;
  failureReason?: string;
  storeUrl?: string;
  sourceArchive?: string;
  storeReview?: StoreReview;
  storeUpload?: StoreUpload;
  failure?: StepFailure;
  retryOf?: string;
  retriedAs?: string;
  run: SubmissionRun;
}

export type PlatformSubmissionsRead =
  | { ok: true; byStore: Record<string, PlatformSubmission> }
  | { ok: false; skipped: true }
  | { ok: false; skipped: false; message: string };

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

/* @invariant A RECORD SAYS THE RETRY ONCE, AND ONLY WHILE IT IS TRUE NEWS.
 * The record GitHub canceled names its retry in `retriedAs`, and the retry
 * names the record it replaces in `retryOf`; the sentence is said for the
 * first, and for the second only while it is still running, since a settled
 * retry speaks for itself through its own status and reason.
 */
export function retryNote(
  submission: { status?: string; retryOf?: string; retriedAs?: string },
  alreadySaid?: string,
): string | null {
  const retried = Boolean(str(submission.retriedAs)) ||
    (Boolean(str(submission.retryOf)) && ["pending", "submitted"].includes(str(submission.status) ?? ""));

  if (!retried || String(alreadySaid ?? "").includes(RETRIED_SENTENCE)) return null;

  return RETRIED_SENTENCE.replace(/\.$/, "");
}

function sameProject(a: { workspace: string; project: string }, b: { workspace: string; project: string }): boolean {
  return a.workspace.toLowerCase() === b.workspace.toLowerCase() && a.project.toLowerCase() === b.project.toLowerCase();
}

function storeReviewOf(raw: unknown): StoreReview | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const row = raw as Record<string, unknown>;
  const state = str(row.state);
  if (!state) return undefined;

  const out: StoreReview = { state };
  const checkedAt = str(row.checkedAt);
  const source = str(row.source);
  const visibility = str(row.visibility);
  const crxVersion = str(row.crxVersion);
  const liveState = str(row.liveState);
  if (checkedAt) out.checkedAt = checkedAt;
  if (source) out.source = source;
  if (visibility) out.visibility = visibility;
  if (crxVersion) out.crxVersion = crxVersion;
  if (liveState) out.liveState = liveState;

  return out;
}

function storeActOf(raw: unknown): StoreAct | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const row = raw as Record<string, unknown>;
  const act = str(row.act);
  const status = str(row.status);
  if (!act || !status) return undefined;

  const out: StoreAct = { act, status };
  const storeMessage = str(row.storeMessage);
  const at = str(row.at);
  if (storeMessage) out.storeMessage = storeMessage;
  if (at) out.at = at;

  return out;
}

/* @invariant THE DISPATCH IS ANSWERED AS A STATE, NEVER AS A RUN. The
 * platform's dispatch record names the run id and its Actions page beside
 * the state; this reader keeps the state, the step and the store's reason,
 * and whether the approval came back, and nothing that names a mirror or a
 * run, which the answers must never carry.
 */
function dispatchOf(raw: unknown): SubmissionDispatch | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const row = raw as Record<string, unknown>;
  const runState = str(row.runState);
  if (!runState) return undefined;

  const out: SubmissionDispatch = { runState, refunded: Boolean(str(row.refundedAt)) };
  const action = str(row.action);
  const dispatchedAt = str(row.dispatchedAt);
  const failedStep = str(row.failedStep);
  const failedReason = str(row.failedReason);
  if (action) out.action = action;
  if (dispatchedAt) out.dispatchedAt = dispatchedAt;
  if (failedStep) out.failedStep = failedStep;
  if (failedReason) out.failedReason = failedReason;

  return out;
}

function storeUploadOf(raw: unknown): StoreUpload | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const row = raw as Record<string, unknown>;
  const state = str(row.state);
  if (!state) return undefined;

  const out: StoreUpload = { state };
  const crxVersion = str(row.crxVersion);
  const checkedAt = str(row.checkedAt);
  if (crxVersion) out.crxVersion = crxVersion;
  if (checkedAt) out.checkedAt = checkedAt;

  return out;
}

export function toSubmission(raw: Record<string, unknown>): PlatformSubmission | null {
  const store = str(raw.store);
  if (!store) return null;

  const runRaw = raw.run && typeof raw.run === "object" ? (raw.run as Record<string, unknown>) : {};
  const run: SubmissionRun = {};
  const status = str(runRaw.status);
  const conclusion = str(runRaw.conclusion);
  const url = str(runRaw.htmlUrl) || str(raw.workflowRunUrl);
  const outcome = str(raw.outcome);
  const failedStep = str(raw.failedStep);
  const message = str(raw.message);
  if (status) run.status = status;
  if (conclusion) run.conclusion = conclusion;
  if (url) run.url = url;
  if (outcome) run.outcome = outcome;
  if (typeof raw.storeReached === "boolean" || raw.storeReached === null) run.storeReached = raw.storeReached as boolean | null;
  if (failedStep) run.failedStep = failedStep;
  if (message) run.message = message;
  if (raw.settled === true) run.settled = true;

  const out: PlatformSubmission = { store, run };
  const storeReview = storeReviewOf(raw.storeReview);
  const storeUpload = storeUploadOf(raw.storeUpload);
  const cancel = storeActOf(raw.cancel);
  const publish = storeActOf(raw.publish);
  const dispatch = dispatchOf(raw.dispatch);
  if (storeReview) out.storeReview = storeReview;
  if (storeUpload) out.storeUpload = storeUpload;
  if (cancel) out.cancel = cancel;
  if (publish) out.publish = publish;
  if (dispatch) out.dispatch = dispatch;

  const failureRaw = raw.failure && typeof raw.failure === "object" ? (raw.failure as Record<string, unknown>) : null;
  const failedAt = failureRaw ? str(failureRaw.step) : undefined;
  if (failedAt) out.failure = { step: failedAt };

  const fields: Array<[keyof PlatformSubmission, unknown]> = [
    ["id", raw.id],
    ["status", raw.status],
    ["rawStatus", raw.rawStatus],
    ["version", raw.version],
    ["buildSha", raw.buildId],
    ["channel", raw.channel],
    ["submittedAt", raw.submittedAt],
    ["failureReason", raw.failureReason],
    ["storeUrl", raw.storeUrl],
    ["sourceArchive", raw.sourceArchive],
    ["retryOf", raw.retryOf],
    ["retriedAs", raw.retriedAs],
  ];

  for (const [key, value] of fields) {
    const text = str(value);
    if (text) (out as unknown as Record<string, string>)[key] = text;
  }

  return out;
}

/* @invariant THE PLATFORM IS ASKED ONLY WITH A TOKEN FOR THE PROJECT BEING
 * READ. The registry files are written from inside the store run, so a run that
 * dies before its record step leaves them silent; the platform's own record,
 * and the run it dispatched, are the only place that outcome exists. That read
 * needs the project's token, and a token for another project would answer for
 * the wrong project, so a mismatch or a token whose project is unknown skips
 * the read rather than guessing.
 */
export async function readPlatformSubmissions(args: {
  ref: { workspace: string; project: string };
  named: boolean;
  api?: string;
}): Promise<PlatformSubmissionsRead> {
  const credential = resolveCredential({
    project: args.named ? `${args.ref.workspace}/${args.ref.project}` : undefined,
    api: args.api,
  });

  if (!credential.token || !credential.ref || !sameProject(credential.ref, args.ref)) {
    return { ok: false, skipped: true };
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);
  if (!apiCheck.ok) return { ok: false, skipped: false, message: apiCheck.message };

  const url = `${apiCheck.base}/api/cli/stores/submissions`;
  const sent = await platformFetch(url, {
    headers: {
      authorization: `Bearer ${credential.token}`,
      ...identityHeaders("extension_release_status"),
    },
  });

  if (!sent.ok) return { ok: false, skipped: false, message: sent.unreached.message };

  const res = sent.res;

  let data: any = null;

  try {
    data = JSON.parse(await res.text());
  } catch {
    data = null;
  }

  if (!res.ok || !data || !Array.isArray(data.submissions)) {
    return {
      ok: false,
      skipped: false,
      message: `${url} answered ${res.status}${str(data?.message) ? ` (${str(data?.message)})` : ""}`,
    };
  }

  const byStore: Record<string, PlatformSubmission> = {};

  for (const raw of data.submissions) {
    if (!raw || typeof raw !== "object") continue;

    const submission = toSubmission(raw as Record<string, unknown>);
    if (submission) byStore[submission.store] = submission;
  }

  return { ok: true, byStore };
}

export type SubmissionRecordRead = RecordRead<PlatformSubmission>;

export async function readSubmissionRecord(
  api: Pick<ProjectApi, "base" | "token" | "command">,
  query: { submissionId?: string; store?: string },
): Promise<SubmissionRecordRead> {
  const submissionId = str(query.submissionId);
  const read = await platformApiGet<{ submissions?: unknown }>(api, "/api/cli/stores/submissions", submissionId ? { submissionId } : undefined);

  if (!read.ok) {
    if (read.status === 404 && read.code === "SUBMISSION_NOT_FOUND") return { ok: true, record: null };

    return missedRead(read);
  }

  const rows = Array.isArray(read.json.submissions) ? read.json.submissions : null;
  if (!rows) return { ok: false, message: `${api.base}/api/cli/stores/submissions answered without a list of submissions` };

  const parsed = rows
    .filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === "object")
    .map(toSubmission)
    .filter((row): row is PlatformSubmission => row !== null);
  const store = str(query.store);
  const found = submissionId
    ? parsed.find((row) => row.id === submissionId)
    : store
      ? parsed.find((row) => row.store === store)
      : parsed[0];

  return { ok: true, record: found ?? null };
}

export async function readSubmissionRecords(
  api: Pick<ProjectApi, "base" | "token" | "command">,
): Promise<RecordRead<Record<string, PlatformSubmission>>> {
  const read = await platformApiGet<{ submissions?: unknown }>(api, "/api/cli/stores/submissions");
  if (!read.ok) return missedRead(read);

  const rows = Array.isArray(read.json.submissions) ? read.json.submissions : null;
  if (!rows) return { ok: false, message: `${api.base}/api/cli/stores/submissions answered without a list of submissions` };

  const byStore: Record<string, PlatformSubmission> = {};

  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;

    const submission = toSubmission(raw as Record<string, unknown>);
    if (submission) byStore[submission.store] = submission;
  }

  return { ok: true, record: byStore };
}

export function isNewerOrSame(platformAt: string | undefined, registryAt: string | undefined): boolean {
  if (!registryAt) return true;

  const p = Date.parse(platformAt || "");
  const r = Date.parse(registryAt);

  if (!Number.isFinite(p)) return false;
  if (!Number.isFinite(r)) return true;

  return p >= r;
}
