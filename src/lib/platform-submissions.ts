// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveCredential } from "./credential-source";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { platformApiGet, type ProjectApi } from "./project-api";
import { identityHeaders } from "./session-identity";

const READ_TIMEOUT_MS = 20_000;

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
}

export interface StoreUpload {
  state: string;
  crxVersion?: string;
  checkedAt?: string;
}

export interface PlatformSubmission {
  id?: string;
  store: string;
  status?: string;
  version?: string;
  buildSha?: string;
  channel?: string;
  submittedAt?: string;
  failureReason?: string;
  storeUrl?: string;
  sourceArchive?: string;
  storeReview?: StoreReview;
  storeUpload?: StoreUpload;
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
  if (checkedAt) out.checkedAt = checkedAt;
  if (source) out.source = source;

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
  if (storeReview) out.storeReview = storeReview;
  if (storeUpload) out.storeUpload = storeUpload;

  const fields: Array<[keyof PlatformSubmission, unknown]> = [
    ["id", raw.id],
    ["status", raw.status],
    ["version", raw.version],
    ["buildSha", raw.buildId],
    ["channel", raw.channel],
    ["submittedAt", raw.submittedAt],
    ["failureReason", raw.failureReason],
    ["storeUrl", raw.storeUrl],
    ["sourceArchive", raw.sourceArchive],
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
  let res: Response;

  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...identityHeaders("extension_release_status"),
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err: any) {
    return { ok: false, skipped: false, message: `could not reach ${url}: ${err?.message || err}` };
  }

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

export type SubmissionRecordRead =
  | { ok: true; record: PlatformSubmission | null }
  | { ok: false; message: string };

export async function readSubmissionRecord(
  api: Pick<ProjectApi, "base" | "token" | "command">,
  query: { submissionId?: string; store?: string },
): Promise<SubmissionRecordRead> {
  const submissionId = str(query.submissionId);
  const read = await platformApiGet<{ submissions?: unknown }>(api, "/api/cli/stores/submissions", submissionId ? { submissionId } : undefined);

  if (!read.ok) {
    if (read.status === 404 && read.code === "SUBMISSION_NOT_FOUND") return { ok: true, record: null };

    return { ok: false, message: read.message };
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
): Promise<{ ok: true; record: Record<string, PlatformSubmission> } | { ok: false; message: string }> {
  const read = await platformApiGet<{ submissions?: unknown }>(api, "/api/cli/stores/submissions");
  if (!read.ok) return { ok: false, message: read.message };

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
