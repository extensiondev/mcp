// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  APPROVAL_DECLINED_STATUS,
  APPROVAL_EXPIRED_STATUS,
  APPROVAL_REJECTED_STATUS,
  pendingApproval,
} from "./approval-outcome";
import { envelope } from "./envelope";
import { parseJsonObject } from "./json-object";
import { platformHoldEnvelope, sawPlatformHold } from "./platform-hold";

export {
  APPROVAL_DECLINED_STATUS,
  APPROVAL_EXPIRED_STATUS,
  APPROVAL_PENDING_STATUS,
  APPROVAL_REJECTED_STATUS,
  APPROVAL_REQUIRED_STATUS,
} from "./approval-outcome";

export type ApprovalScope = Record<string, string | string[]>;

export interface ApprovalGateInput {
  command: string;
  action: string;
  scope: ApprovalScope;
  description: string;
  approvalId?: string;
  token: string;
  api?: string;
  fetchImpl?: typeof fetch;
  enabled?: boolean;
  now?: number;
  refusedStatus?: string;
  refusalHint?: (platformCode: string) => string | undefined;
  body?: Record<string, unknown>;
  reason?: string;
  stateRead?: string;
  irreversible?: boolean;
}

export type ApprovalGateResult =
  | { blocked: false; approvalId?: string }
  | { blocked: true; envelope: string };

export interface ExpiredApproval {
  approvalId: string;
  expiresAt: string;
}

export type ApprovalRenewer = (expired: ExpiredApproval) => Promise<ApprovalGateResult>;

export function block(
  command: string,
  status: string,
  code: string,
  name: string,
  message: string,
  value: Record<string, unknown>,
  hint?: string,
): { blocked: true; envelope: string } {
  return {
    blocked: true,
    envelope: envelope({
      ok: false,
      command,
      status,
      value,
      error: { code, name, message },
      ...(hint ? { hint } : {}),
    }),
  };
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const read = parseJsonObject(text);

  return "value" in read ? read.value : { message: text };
}

export function actionPhrase(input: Pick<ApprovalGateInput, "irreversible">): string {
  return input.irreversible ? "this irreversible action" : "this action";
}

export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function withoutClosingStop(text: string): string {
  return text.trim().replace(/[.!?\s]+$/, "");
}

function scopeMismatch(input: ApprovalGateInput, approvalId: string, fingerprint: string, approvedFingerprint: string): { blocked: true; envelope: string } {
  return block(
    input.command,
    APPROVAL_REJECTED_STATUS,
    "E_APPROVAL_REJECTED",
    "ApprovalScopeMismatch",
    `Approval ${approvalId} was granted for a different action and cannot authorize ${input.action}: ${input.description} Request a fresh approval for this exact action by calling this tool with no approvalId.`,
    {
      action: input.action,
      approvalId,
      expectedFingerprint: fingerprint,
      approvedFingerprint,
    },
  );
}

function expiredBlock(input: ApprovalGateInput, approvalId: string, expiresAt?: string, reason?: string): { blocked: true; envelope: string } {
  const when = expiresAt ? ` at ${expiresAt}` : "";
  const cause = reason ? ` A fresh approval could not be requested: ${withoutClosingStop(reason)}.` : "";

  return block(
    input.command,
    APPROVAL_EXPIRED_STATUS,
    "E_APPROVAL_REJECTED",
    "ApprovalExpired",
    `Approval ${approvalId} expired${when}, so nothing was executed.${cause} Request a fresh approval by calling this tool with no approvalId.`,
    { action: input.action, approvalId, ...(expiresAt ? { expiresAt } : {}) },
  );
}

function renewedUrl(result: ApprovalGateResult): { url: string; reason: string } {
  if (!result.blocked) return { url: "", reason: "" };

  try {
    const parsed = JSON.parse(result.envelope) as { status?: unknown; value?: { approvalUrl?: unknown }; error?: { message?: unknown } };
    const url = parsed.status === "approval-required" && typeof parsed.value?.approvalUrl === "string" ? parsed.value.approvalUrl : "";

    return { url, reason: typeof parsed.error?.message === "string" ? parsed.error.message : "" };
  } catch {
    return { url: "", reason: "" };
  }
}

export async function verifyApproval(params: {
  base: string;
  fingerprint: string;
  input: ApprovalGateInput;
  doFetch: typeof fetch;
  renew?: ApprovalRenewer;
}): Promise<ApprovalGateResult> {
  const { base, fingerprint, input, doFetch, renew } = params;
  const approvalId = String(input.approvalId || "").trim();
  const url = `${base}/api/cli/approvals/${encodeURIComponent(approvalId)}`;
  let res: Response;

  try {
    res = await doFetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
      },
    });
  } catch (err: any) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalUnverifiable",
      `The approval ${approvalId} could not be verified with the platform (${
        err?.message || err
      }), so ${actionPhrase(input)} was refused. Nothing was executed.`,
      { action: input.action, approvalId, fingerprint },
    );
  }

  const data = await readJson(res);

  if (sawPlatformHold(res, data)) {
    return {
      blocked: true,
      envelope: platformHoldEnvelope({
        command: input.command,
        name: "ApprovalHeld",
        body: data,
        api: input.api,
        value: { action: input.action, approvalId },
      }),
    };
  }

  const platformCode = typeof data.code === "string" ? data.code : "";

  if (res.status === 410 && platformCode === "APPROVAL_EXPIRED") {
    const expiresAt = typeof data.expiresAt === "string" ? data.expiresAt.trim() : "";
    const expiredFingerprint = typeof data.fingerprint === "string" ? data.fingerprint.trim() : "";

    if (expiredFingerprint && expiredFingerprint !== fingerprint) {
      return scopeMismatch(input, approvalId, fingerprint, expiredFingerprint);
    }

    if (!renew) return expiredBlock(input, approvalId, expiresAt);

    const renewed = await renew({ approvalId, expiresAt });
    const fresh = renewedUrl(renewed);

    return fresh.url ? renewed : expiredBlock(input, approvalId, expiresAt, fresh.reason);
  }

  if (res.status === 404 && (platformCode === "APPROVAL_UNKNOWN" || platformCode === "APPROVAL_NOT_FOUND")) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalUnknown",
      `The platform does not know approval ${approvalId}; it may have been minted for another server or project. ${sentenceCase(actionPhrase(input))} was refused and nothing was executed. Request a fresh approval by calling this tool with no approvalId.`,
      { action: input.action, approvalId, fingerprint, platformCode },
    );
  }

  if (!res.ok) {
    const reason = typeof data.message === "string" ? withoutClosingStop(data.message) : "";

    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalUnverifiable",
      `The platform did not confirm approval ${approvalId} (${res.status}): ${reason || "no reason given"}. ${sentenceCase(actionPhrase(input))} was refused. Request a fresh approval by calling this tool with no approvalId.`,
      { action: input.action, approvalId, fingerprint },
    );
  }

  const status = String(data.status || "")
    .trim()
    .toLowerCase();
  const storedFingerprint = String(data.fingerprint || "").trim();
  const used = data.used === true;
  const now = input.now ?? Date.now();
  const expiresAt =
    typeof data.expiresAt === "string"
      ? Date.parse(data.expiresAt)
      : typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)
        ? data.expiresAt > 1e12
          ? data.expiresAt
          : data.expiresAt * 1000
        : NaN;
  const expired =
    status === "expired" || (Number.isFinite(expiresAt) && expiresAt <= now);

  if (storedFingerprint && storedFingerprint !== fingerprint) {
    return scopeMismatch(input, approvalId, fingerprint, storedFingerprint);
  }

  if (status === "approved" && (!storedFingerprint || !Number.isFinite(expiresAt) || typeof data.used !== "boolean")) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalUnverifiable",
      `The platform's record of approval ${approvalId} reads approved but lacks ${[
        !storedFingerprint ? "its fingerprint" : null,
        !Number.isFinite(expiresAt) ? "a readable expiry" : null,
        typeof data.used !== "boolean" ? "its single-use flag" : null,
      ]
        .filter(Boolean)
        .join(", ")}, so it cannot be matched to this action. ${sentenceCase(actionPhrase(input))} was refused. Request a fresh approval by calling this tool with no approvalId.`,
      { action: input.action, approvalId, fingerprint },
    );
  }

  if (status === "denied") {
    return block(
      input.command,
      APPROVAL_DECLINED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalDeclined",
      `Approval ${approvalId} was declined by a workspace owner, so nothing was executed.`,
      { action: input.action, approvalId },
      "Ask the person whether they still want it before requesting a fresh approval by calling this tool with no approvalId.",
    );
  }

  if (expired) {
    return block(
      input.command,
      APPROVAL_EXPIRED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalExpired",
      `Approval ${approvalId} has expired, so nothing was executed. Request a fresh approval by calling this tool with no approvalId.`,
      { action: input.action, approvalId },
    );
  }

  if (used) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalConsumed",
      `Approval ${approvalId} was already used once and approvals are single-use. This call executed nothing, but the call that used it may already have run the action: ${input.description} Read the current state first (${input.stateRead ?? "extension_release_status for a promote or submission, extension_shares list for a revoke"}), and request a fresh approval by calling this tool with no approvalId only if the action did not happen.`,
      { action: input.action, approvalId },
    );
  }

  if (status !== "approved") {
    return {
      blocked: true,
      envelope: pendingApproval({
        command: input.command,
        approvalId,
        message: `Approval ${approvalId} has not been granted yet: ${input.description}`,
        undone: "Nothing was executed.",
        api: input.api,
        approvalUrl: typeof data.approvalUrl === "string" ? data.approvalUrl.trim() : undefined,
        value: { action: input.action, status: status || "pending" },
      }),
    };
  }

  return { blocked: false, approvalId };
}
