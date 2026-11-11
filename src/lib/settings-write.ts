// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { actionFingerprint, evaluateApproval, requestApprovalAfterRefusal, type ApprovalGateInput } from "./approval-gate";
import { approvalRoundTrip } from "./approval-outcome";
import { askingOnly } from "./ask-only";
import { verdictOfAction, type ApprovalVerdict } from "./approval-policy";
import { projectApiSend, type ProjectApi, type ProjectApiRefusal } from "./project-api";
import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

/* @invariant A SETTINGS WRITE IS SENT PLAINLY, AND AN APPROVAL IS MINTED ONLY
 * WHEN THE PLATFORM ASKS. Every settings write this server makes (build
 * settings, store settings, a channel's audience and fields, a project's
 * visibility) goes through here. The policy table
 * (approval-policy.ts) says a settings write is a plain act under the
 * owner's own token, so the write goes out with no approval and no approval
 * is minted first; the platform answers APPROVAL_REQUIRED only for an
 * audience change it computed from the write (a submission mode that sends
 * the next upload to a review that publishes it, a public channel, a public
 * project), and that request is honored with the fingerprint it
 * named. An approvalId the caller presents is verified first, whatever the
 * verdict, so a pending or spent grant answers legibly instead of reaching
 * the platform.
 */
export interface SettingsWrite {
  api: ProjectApi;
  method?: "PUT" | "PATCH";
  route: string;
  body: Row;
  approvalId: string;
  gate: ApprovalGateInput;
  mismatch: () => string;
  undone: string;
  value: Row;
  next?: { used: string };
  readBack?: () => Promise<ReadBack>;
}

export type Saved = "yes" | "no" | "unknown";

export interface ReadBack {
  saved: Saved;
  state?: Row;
}

export interface UnconfirmedWrite {
  attempt: number;
  saved: Saved;
  state?: Row;
}

export type SettingsWriteResult =
  | { ok: true; json: Row; verdict: ApprovalVerdict }
  | { ok: false; out?: string; sent: ProjectApiRefusal; unconfirmed?: UnconfirmedWrite };

export const UNCONFIRMED_RETRY_SECONDS = 10;
export const WRITE_FAILURE_REPORT_URL = "https://github.com/extensiondev/mcp/issues";

const unconfirmedWrites = new Map<string, number>();
const UNCONFIRMED_WRITES_LIMIT = 256;

function writeKey(write: SettingsWrite): string {
  return `${write.api.base}\n${write.api.projectId}\n${write.method ?? "PUT"}\n${write.route}\n${JSON.stringify(write.body)}`;
}

function countUnconfirmed(key: string): number {
  const attempt = (unconfirmedWrites.get(key) ?? 0) + 1;
  unconfirmedWrites.delete(key);
  unconfirmedWrites.set(key, attempt);

  for (const oldest of unconfirmedWrites.keys()) {
    if (unconfirmedWrites.size <= UNCONFIRMED_WRITES_LIMIT) break;

    unconfirmedWrites.delete(oldest);
  }

  return attempt;
}

export function unconfirmedWriteSentence(args: { what: string; unconfirmed: UnconfirmedWrite; page: string; pageWord: string }): string {
  const { what, unconfirmed, page, pageWord } = args;
  const stored =
    unconfirmed.saved === "no"
      ? `The ${what} read back unchanged, so nothing was saved.`
      : `The ${what} could not be read back after it, so whether anything was saved is unknown.`;

  if (unconfirmed.attempt >= 2) {
    return `${stored} This is 5xx number ${unconfirmed.attempt} for this same change, so stop retrying: make the change on the ${pageWord} at ${page}, and report the failure with the time and the project at ${WRITE_FAILURE_REPORT_URL}.`;
  }

  return `${stored} The write is a whole-state ${unconfirmed.saved === "no" ? "PUT" : "write"} the platform applies the same way twice, so sending it again is safe: wait about ${UNCONFIRMED_RETRY_SECONDS} seconds and call again with the same arguments, once. If that answers a 5xx too, stop and make the change on the ${pageWord} at ${page}.`;
}

export function settingsWriteVerdict(write: Pick<SettingsWrite, "gate">): ApprovalVerdict {
  return verdictOfAction(write.gate.action, write.gate.write);
}

export async function approvedSettingsWrite(write: SettingsWrite): Promise<SettingsWriteResult> {
  const approvalId = text(write.approvalId);

  if (approvalId) {
    const gate = await evaluateApproval({ ...write.gate, approvalId, enabled: true });
    if (gate.blocked) return { ok: false, out: gate.envelope, sent: refusedByGate() };
  }

  if (!approvalId && askingOnly() && settingsWriteVerdict(write) === "approval") {
    return { ok: false, out: await requestApprovalAfterRefusal(write.gate), sent: refusedByGate() };
  }

  const key = writeKey(write);
  const sent = await projectApiSend<Row>(write.api, write.method ?? "PUT", write.route, { ...write.body, ...(approvalId ? { approvalId } : {}) });

  if (sent.ok) {
    unconfirmedWrites.delete(key);

    return { ok: true, json: isRow(sent.json) ? sent.json : {}, verdict: settingsWriteVerdict(write) };
  }

  if (!approvalId && sent.code === "APPROVAL_REQUIRED") {
    const asked = isRow(sent.body) && isRow(sent.body.approvalRequest) ? sent.body.approvalRequest : {};
    const ours = actionFingerprint(write.gate.action, write.gate.scope);

    if (text(asked.fingerprint) && text(asked.fingerprint) !== ours) return { ok: false, out: write.mismatch(), sent };

    return { ok: false, out: await requestApprovalAfterRefusal(write.gate), sent };
  }

  const answered = approvalRoundTrip({
    command: write.gate.command,
    platformCode: sent.code,
    message: sent.message,
    approvalId,
    undone: write.undone,
    api: write.gate.api,
    value: write.value,
    next: write.next,
    retryAfterSeconds: sent.retryAfterSeconds,
  });

  if (answered) return { ok: false, out: answered, sent };
  if (sent.status < 500 || sent.held) return { ok: false, sent };

  const attempt = countUnconfirmed(key);
  const read = write.readBack ? await write.readBack() : { saved: "unknown" as const };
  if (read.saved === "yes") unconfirmedWrites.delete(key);

  return { ok: false, sent, unconfirmed: { attempt, saved: read.saved, ...(read.state ? { state: read.state } : {}) } };
}

function refusedByGate(): ProjectApiRefusal {
  return { ok: false, status: 0, code: "", message: "", held: false, body: null };
}
