// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { actionFingerprint, evaluateApproval, requestApprovalAfterRefusal, type ApprovalGateInput } from "./approval-gate";
import { approvalRoundTrip } from "./approval-outcome";
import { projectApiSend, type ProjectApi, type ProjectApiRefusal } from "./project-api";
import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

export type SettingsWriteGate = "owner-approval" | "client-prompt";

/* @invariant ONE SWITCH DECIDES HOW A SETTINGS WRITE IS GATED. Every
 * settings write this server makes (build settings, store settings) goes
 * through approvedSettingsWrite, and this constant is the only place that
 * says whether the write needs a workspace owner's approval on the platform's
 * approve page ("owner-approval", the rule in force) or rides the MCP
 * client's own permission prompt ("client-prompt", the shape ledger entry 143
 * asks for, with the approve page kept for irreversible acts). Flipping it
 * here, with the matching constant on the platform route, is the whole
 * change; no tool reads the gate on its own.
 */
export const SETTINGS_WRITE_GATE: SettingsWriteGate = "owner-approval";

export interface SettingsWrite {
  api: ProjectApi;
  route: string;
  body: Row;
  approvalId: string;
  gate: ApprovalGateInput;
  mismatch: () => string;
  undone: string;
  value: Row;
  next?: { used: string };
}

export type SettingsWriteResult = { ok: true; json: Row } | { ok: false; out?: string; sent: ProjectApiRefusal };

export async function approvedSettingsWrite(write: SettingsWrite): Promise<SettingsWriteResult> {
  const gated = SETTINGS_WRITE_GATE === "owner-approval";
  const approvalId = text(write.approvalId);

  if (gated && approvalId) {
    const gate = await evaluateApproval({ ...write.gate, approvalId, enabled: true });
    if (gate.blocked) return { ok: false, out: gate.envelope, sent: refusedByGate() };
  }

  const sent = await projectApiSend<Row>(write.api, "PUT", write.route, { ...write.body, ...(approvalId ? { approvalId } : {}) });
  if (sent.ok) return { ok: true, json: isRow(sent.json) ? sent.json : {} };

  if (gated && !approvalId && sent.code === "APPROVAL_REQUIRED") {
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
