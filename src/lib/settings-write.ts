// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { actionFingerprint, evaluateApproval, requestApprovalAfterRefusal, type ApprovalGateInput } from "./approval-gate";
import { approvalRoundTrip } from "./approval-outcome";
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
}

export type SettingsWriteResult = { ok: true; json: Row; verdict: ApprovalVerdict } | { ok: false; out?: string; sent: ProjectApiRefusal };

export function settingsWriteVerdict(write: Pick<SettingsWrite, "gate">): ApprovalVerdict {
  return verdictOfAction(write.gate.action, write.gate.write);
}

export async function approvedSettingsWrite(write: SettingsWrite): Promise<SettingsWriteResult> {
  const approvalId = text(write.approvalId);

  if (approvalId) {
    const gate = await evaluateApproval({ ...write.gate, approvalId, enabled: true });
    if (gate.blocked) return { ok: false, out: gate.envelope, sent: refusedByGate() };
  }

  const sent = await projectApiSend<Row>(write.api, write.method ?? "PUT", write.route, { ...write.body, ...(approvalId ? { approvalId } : {}) });
  if (sent.ok) return { ok: true, json: isRow(sent.json) ? sent.json : {}, verdict: settingsWriteVerdict(write) };

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

  return answered ? { ok: false, out: answered, sent } : { ok: false, sent };
}

function refusedByGate(): ProjectApiRefusal {
  return { ok: false, status: 0, code: "", message: "", held: false, body: null };
}
