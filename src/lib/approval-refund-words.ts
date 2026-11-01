// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface ApprovalRefund {
  approvalRefunded?: true;
  approvalRefundReason?: string;
}

export const APPROVAL_REFUND_SENTENCE =
  "GitHub ended this run before any step started, so the platform gave back the approval it spent (this store's upload line on the version approval, or an approval that named this store alone); submitting the same build to this store again needs no new approval while that approval is unexpired";

export function approvalRefundOf(raw: object | null | undefined): ApprovalRefund {
  const row = (raw ?? {}) as Record<string, unknown>;
  if (row.approvalRefunded !== true) return {};

  const reason = String(row.approvalRefundReason ?? "").trim();

  return { approvalRefunded: true, ...(reason ? { approvalRefundReason: reason } : {}) };
}

export function approvalRefundSentence(row: ApprovalRefund | null | undefined, alreadySaid?: string): string | null {
  if (row?.approvalRefunded !== true || String(alreadySaid ?? "").includes(APPROVAL_REFUND_SENTENCE)) return null;

  const reason = String(row.approvalRefundReason ?? "").trim().replace(/[.\s]+$/, "");
  const extra = reason && !/before any step/i.test(reason) ? ` (the platform's reason: ${reason})` : "";

  return `${APPROVAL_REFUND_SENTENCE}${extra}`;
}
