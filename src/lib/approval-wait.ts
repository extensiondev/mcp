// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { outcomeClock, waitBound } from "./act-outcome";
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

async function stillWaiting(approvalId: string, args: Args): Promise<boolean> {
  const api = text(args.api) || undefined;
  const token = resolveCredential({ project: text(args.project) || undefined, api }).token;
  const check = safeApiBase(resolveApiBase(api), api);
  if (!token || !check.ok) return false;

  const sent = await platformFetch(
    `${check.base}/api/cli/approvals/${encodeURIComponent(approvalId)}`,
    { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
    { kind: "read" },
  );
  if (!sent.ok) return true;
  if (!sent.res.ok) return false;

  try {
    const body = JSON.parse(await sent.res.text()) as { status?: unknown };
    const status = String(body?.status ?? "").trim().toLowerCase();

    return status === "" || status === "pending";
  } catch {
    return false;
  }
}

function withWaited(answer: string, waitedSeconds: number, pending: boolean): string {
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
    ? `This call waited ${waitedSeconds} s for the approval, which nobody has decided yet.`
    : `This call waited ${waitedSeconds} s for the approval, then went on once it was decided.`;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: { ...value, approvalWaitedSeconds: waitedSeconds },
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
 * waited (ledger 254: the agent slept in a shell between calls). A call with
 * no waitSeconds answers at once, as before.
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
  const waited = (): number => Math.round((outcomeClock.now() - started) / 1000);

  for (;;) {
    const elapsed = outcomeClock.now() - started;
    if (elapsed >= boundMs) return withWaited(last, waited(), true);

    await outcomeClock.sleep(Math.min(retry * 1000, boundMs - elapsed));
    if (await stillWaiting(approvalId, args)) continue;

    const decided = waited();
    const left = Math.max(0, Math.round((boundMs - (outcomeClock.now() - started)) / 1000));
    const answer = await call({ ...args, waitSeconds: left });
    const again = pendingRetry(answer);

    if (again === null) return withWaited(answer, decided, false);

    retry = again;
    last = answer;
  }
}
