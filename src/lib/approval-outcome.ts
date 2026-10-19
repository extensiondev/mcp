// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { resolveApiBase } from "./login-flow";

export const APPROVAL_REQUIRED_STATUS = "approval-required";
export const APPROVAL_PENDING_STATUS = "approval-pending";
export const APPROVAL_DECLINED_STATUS = "approval-declined";
export const APPROVAL_EXPIRED_STATUS = "approval-expired";
export const APPROVAL_REJECTED_STATUS = "approval-rejected";
export const APPROVAL_PENDING_RETRY_SECONDS = 10;

export type ApprovalOutcomeKind = "pending" | "declined" | "expired" | "used" | "unverifiable" | "mismatch";

const KIND_OF_CODE: Record<string, ApprovalOutcomeKind> = {
  APPROVAL_PENDING: "pending",
  APPROVAL_DENIED: "declined",
  APPROVAL_DECLINED: "declined",
  APPROVAL_EXPIRED: "expired",
  APPROVAL_CONSUMED: "used",
  APPROVAL_USED: "used",
  APPROVAL_NOT_FOUND: "unverifiable",
  APPROVAL_SCOPE_MISMATCH: "mismatch",
};

const STATE_READ = "{stateRead}";

const OUTCOMES: Record<Exclude<ApprovalOutcomeKind, "pending">, { status: string; name: string; next: string }> = {
  declined: {
    status: APPROVAL_DECLINED_STATUS,
    name: "ApprovalDeclined",
    next: "A workspace owner declined it, so nothing happened. Ask the person whether they still want it before requesting a fresh approval by calling again with no approvalId.",
  },
  expired: { status: APPROVAL_EXPIRED_STATUS, name: "ApprovalExpired", next: "Request a fresh approval by calling again with no approvalId." },
  used: {
    status: APPROVAL_REJECTED_STATUS,
    name: "ApprovalConsumed",
    next: `The call that used it may already have done this: read ${STATE_READ} first, and request a fresh approval only if it did not happen.`,
  },
  unverifiable: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalUnverifiable", next: "Request a fresh approval by calling again with no approvalId." },
  mismatch: {
    status: APPROVAL_REJECTED_STATUS,
    name: "ApprovalScopeMismatch",
    next: "That approval covers a different act, or what this act would do changed since it was approved; request a fresh one by calling again with no approvalId.",
  },
};

export function approvalOutcomeKind(platformCode: string): ApprovalOutcomeKind | undefined {
  return KIND_OF_CODE[platformCode];
}

export function approvalUrlFor(approvalId: string, api?: string): string {
  return `${resolveApiBase(api)}/device/approve/${encodeURIComponent(approvalId)}`;
}

function closed(message: string): string {
  const trimmed = message.trim();

  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface PendingApproval {
  command: string;
  approvalId: string;
  message: string;
  undone: string;
  api?: string;
  approvalUrl?: string;
  value?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export function pendingApproval(input: PendingApproval): string {
  const approvalUrl = input.approvalUrl || approvalUrlFor(input.approvalId, input.api);
  const retryAfterSeconds = input.retryAfterSeconds && input.retryAfterSeconds > 0 ? input.retryAfterSeconds : APPROVAL_PENDING_RETRY_SECONDS;

  return envelope({
    ok: true,
    command: input.command,
    status: APPROVAL_PENDING_STATUS,
    value: { ...(input.value ?? {}), approvalId: input.approvalId, approvalUrl, retryAfterSeconds },
    hint: `${closed(input.message)} A person approves at the link: ${approvalUrl}. ${closed(input.undone)} Once it is approved, call again with the same arguments and approvalId ${input.approvalId}; check back in about ${retryAfterSeconds} seconds. Do not request a fresh approval while this one waits.`,
  });
}

export interface ApprovalRoundTrip {
  command: string;
  platformCode: string;
  message: string;
  approvalId: string;
  undone: string;
  api?: string;
  value?: Record<string, unknown>;
  stateRead?: string;
  next?: Partial<Record<ApprovalOutcomeKind, string>>;
  retryAfterSeconds?: number;
}

export function approvalRoundTrip(trip: ApprovalRoundTrip): string | undefined {
  const kind = approvalOutcomeKind(trip.platformCode);
  if (!kind) return undefined;

  const value = { ...(trip.value ?? {}), approvalId: trip.approvalId };

  if (kind === "pending") {
    return pendingApproval({
      command: trip.command,
      approvalId: trip.approvalId,
      message: trip.message || "This approval has not been granted yet.",
      undone: trip.undone,
      api: trip.api,
      value: { ...value, platformCode: trip.platformCode },
      retryAfterSeconds: trip.retryAfterSeconds,
    });
  }

  const outcome = OUTCOMES[kind];
  const next = (trip.next?.[kind] ?? outcome.next).replace(STATE_READ, trip.stateRead ?? "the current state");

  return envelope({
    ok: false,
    command: trip.command,
    status: outcome.status,
    value,
    error: {
      code: "E_APPROVAL_REJECTED",
      name: outcome.name,
      platformCode: trip.platformCode,
      message: `${closed(trip.message)} ${closed(trip.undone)}`.trim(),
    },
    hint: next,
  });
}
