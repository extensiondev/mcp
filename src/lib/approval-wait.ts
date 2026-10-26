// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { TRANSIENT_READ_STATUSES, missesSentence, outcomeClock, waitBound } from "./act-outcome";
import { APPROVAL_PENDING_RETRY_SECONDS, APPROVAL_PENDING_STATUS } from "./approval-outcome";
import { resolveCredential } from "./credential-source";
import { envelope, isEnvelope, type Envelope } from "./envelope";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { platformFetch } from "./platform-fetch";

type Args = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pendingRetry(answer: string): number | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }

  if (!isEnvelope(parsed) || parsed.status !== APPROVAL_PENDING_STATUS) return null;

  const value = parsed.value && typeof parsed.value === "object" ? (parsed.value as Args) : {};
  const seconds = Number(value.retryAfterSeconds);

  return Number.isFinite(seconds) && seconds > 0 ? seconds : APPROVAL_PENDING_RETRY_SECONDS;
}

type ApprovalPoll = { state: "pending" | "decided" } | { state: "missed"; problem: string };

async function pollApproval(approvalId: string, args: Args): Promise<ApprovalPoll> {
  const api = text(args.api) || undefined;
  const token = resolveCredential({ project: text(args.project) || undefined, api }).token;
  const check = safeApiBase(resolveApiBase(api), api);
  if (!token || !check.ok) return { state: "decided" };

  const url = `${check.base}/api/cli/approvals/${encodeURIComponent(approvalId)}`;
  const sent = await platformFetch(
    url,
    { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
    { kind: "read" },
  );
  if (!sent.ok) return { state: "missed", problem: sent.unreached.message };
  if (TRANSIENT_READ_STATUSES.has(sent.res.status)) return { state: "missed", problem: `${url} answered ${sent.res.status}` };
  if (!sent.res.ok) return { state: "decided" };

  try {
    const body = JSON.parse(await sent.res.text()) as { status?: unknown };
    const status = String(body?.status ?? "").trim().toLowerCase();

    return { state: status === "" || status === "pending" ? "pending" : "decided" };
  } catch {
    return { state: "decided" };
  }
}

function withWaited(answer: string, waitedSeconds: number, pending: boolean, readProblem?: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(answer);
  } catch {
    return answer;
  }

  if (!isEnvelope(parsed)) return answer;

  const frame = parsed as Envelope & { hint?: string };
  const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? (frame.value as Args) : {};
  const said = pending
    ? `This call waited ${waitedSeconds} s for the approval, which nobody has decided yet${readProblem ? `; the approval itself could not always be read (${readProblem})` : ""}.`
    : `This call waited ${waitedSeconds} s for the approval, then went on once it was decided.`;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: { ...value, approvalWaitedSeconds: waitedSeconds, ...(readProblem ? { readProblem } : {}) },
    error: frame.error ?? undefined,
    warnings: frame.warnings,
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    hint: [said, frame.hint].filter(Boolean).join(" "),
  });
}

/* @invariant AN APPROVAL STILL WAITING FOR A PERSON IS WAITED FOR INSIDE THE
 * CALL WHEN THE CALL ASKED TO WAIT. A call carrying approvalId and
 * waitSeconds that answers approval-pending executed nothing, so this polls
 * the approval itself every retryAfterSeconds until the bound passes; the
 * moment the platform no longer reads it as pending, the same call runs again
 * with the same arguments and whatever is left of waitSeconds for the record
 * wait, so a granted approval dispatches and answers its recorded outcome in
 * one call and a declined or expired one answers its own refusal. Only when
 * the bound passes does the answer stay approval-pending, saying how long it
 * waited (ledger 254: the agent slept in a shell between calls). A poll the
 * platform does not answer (a timeout, a refused connection, a 429 or a 5xx)
 * is a miss, not a decision: the wait goes on, and only an answer at the
 * bound names the misses in readProblem. A call with no waitSeconds answers
 * at once, as before.
 */
export async function answerOnceDecided(args: Args, call: (args: Args) => Promise<string>): Promise<string> {
  const first = await call(args);
  const approvalId = text(args.approvalId);
  if (!approvalId || args.waitSeconds === undefined || args.waitSeconds === null) return first;

  let retry = pendingRetry(first);
  if (retry === null) return first;

  const boundMs = waitBound(args.waitSeconds) * 1000;
  const started = outcomeClock.now();
  let last = first;
  let misses = 0;
  let lastMiss = "";
  const waited = (): number => Math.round((outcomeClock.now() - started) / 1000);

  for (;;) {
    const elapsed = outcomeClock.now() - started;
    if (elapsed >= boundMs) return withWaited(last, waited(), true, misses ? missesSentence(misses, waited(), lastMiss, "the approval") : undefined);

    await outcomeClock.sleep(Math.min(retry * 1000, boundMs - elapsed));
    const poll = await pollApproval(approvalId, args);

    if (poll.state === "missed") {
      misses += 1;
      lastMiss = poll.problem;
      continue;
    }

    if (poll.state === "pending") continue;

    const decided = waited();
    const left = Math.max(0, Math.round((boundMs - (outcomeClock.now() - started)) / 1000));
    const answer = await call({ ...args, waitSeconds: left });
    const again = pendingRetry(answer);

    if (again === null) return withWaited(answer, decided, false);

    retry = again;
    last = answer;
  }
}
