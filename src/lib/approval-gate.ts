// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { envelope } from "./envelope";
import { parseJsonObject } from "./json-object";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { platformHoldEnvelope, sawPlatformHold } from "./platform-hold";

export const APPROVAL_GATE_ENV = "EXTENSION_DEV_APPROVAL_GATE";

export const APPROVAL_REQUIRED_STATUS = "approval-required";
export const APPROVAL_PENDING_STATUS = "approval-pending";
export const APPROVAL_REJECTED_STATUS = "approval-rejected";

export function approvalGateEnabled(defaultOn = false): boolean {
  const raw = String(process.env[APPROVAL_GATE_ENV] || "")
    .trim()
    .toLowerCase();
  if (raw === "") return defaultOn;

  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function platformRequiresApproval(
  res: { status: number },
  data: unknown,
): boolean {
  return (
    res.status === 403 &&
    !!data &&
    typeof data === "object" &&
    (data as Record<string, unknown>).code === "APPROVAL_REQUIRED"
  );
}

export async function requestApprovalAfterRefusal(
  input: ApprovalGateInput,
): Promise<string> {
  const gate = await evaluateApproval({
    ...input,
    approvalId: undefined,
    enabled: true,
  });

  return gate.blocked
    ? gate.envelope
    : envelope({
        ok: false,
        command: input.command,
        status: APPROVAL_REQUIRED_STATUS,
        error: {
          code: "E_APPROVAL_REQUIRED",
          message: "The platform requires an approval for this action.",
        },
      });
}

export type ApprovalScope = Record<string, string | string[]>;

function canonicalScope(scope: ApprovalScope): string {
  return Object.keys(scope)
    .sort()
    .map((key) => {
      const value = scope[key];
      const rendered = Array.isArray(value)
        ? [...value].map((v) => String(v)).sort().join(",")
        : String(value);

      return `${key}=${rendered}`;
    })
    .join("\n");
}

export function actionFingerprint(
  action: string,
  scope: ApprovalScope,
): string {
  return crypto
    .createHash("sha256")
    .update(`${action}\n${canonicalScope(scope)}`)
    .digest("hex");
}

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
}

export type ApprovalGateResult =
  | { blocked: false; approvalId?: string }
  | { blocked: true; envelope: string };

function block(
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

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const read = parseJsonObject(text);

  return "value" in read ? read.value : { message: text };
}

async function requestApproval(params: {
  base: string;
  fingerprint: string;
  input: ApprovalGateInput;
  doFetch: typeof fetch;
}): Promise<{ blocked: true; envelope: string }> {
  const { base, fingerprint, input, doFetch } = params;
  const url = `${base}/api/cli/approvals`;
  let res: Response;

  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: input.action,
        fingerprint,
        scope: input.scope,
        description: input.description,
      }),
    });
  } catch (err: any) {
    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRequired",
      `A human must approve this irreversible action before it runs, and the approval could not be requested from ${url}: ${
        err?.message || err
      }. Nothing was executed. Retry once the platform is reachable.`,
      { action: input.action, fingerprint, description: input.description },
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
        value: { action: input.action, description: input.description },
      }),
    };
  }

  if (!res.ok) {
    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRequired",
      `A human must approve this irreversible action before it runs. The platform did not create an approval request (${res.status}): ${
        typeof data.message === "string" && data.message
          ? data.message
          : "no approval endpoint answered"
      }. Nothing was executed.`,
      { action: input.action, fingerprint, description: input.description },
    );
  }

  const approvalId = String(data.approvalId || "").trim();
  const approvalUrl = String(data.approvalUrl || "").trim();

  if (!approvalId) {
    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRequestUnconfirmed",
      `A human must approve this irreversible action before it runs, and the platform answered the approval request (${res.status}) without an approval id, so no approval is known to exist. Nothing was executed; call this tool again to request one.`,
      { action: input.action, fingerprint, description: input.description },
    );
  }

  return block(
    input.command,
    APPROVAL_REQUIRED_STATUS,
    "E_APPROVAL_REQUIRED",
    "ApprovalRequired",
    `${input.description} This is irreversible, so a human must approve it first. Open ${
      approvalUrl || "the approval URL"
    } to review and approve, then call this tool again with approvalId ${
      approvalId || "<from the response>"
    }. Nothing was executed.`,
    {
      action: input.action,
      fingerprint,
      description: input.description,
      ...(approvalId ? { approvalId } : {}),
      ...(approvalUrl ? { approvalUrl } : {}),
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    },
    approvalUrl
      ? `Approve at ${approvalUrl}, then re-run with approvalId ${approvalId}.`
      : undefined,
  );
}

async function verifyApproval(params: {
  base: string;
  fingerprint: string;
  input: ApprovalGateInput;
  doFetch: typeof fetch;
}): Promise<ApprovalGateResult> {
  const { base, fingerprint, input, doFetch } = params;
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
      }), so this irreversible action was refused. Nothing was executed.`,
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

  if (!res.ok) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalUnverifiable",
      `The platform did not confirm approval ${approvalId} (${res.status}): ${
        typeof data.message === "string" && data.message
          ? data.message
          : "unknown approval"
      }. This irreversible action was refused. Request a fresh approval by calling this tool with no approvalId.`,
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
        approvedFingerprint: storedFingerprint,
      },
    );
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
        .join(", ")}, so it cannot be matched to this action. This irreversible action was refused. Request a fresh approval by calling this tool with no approvalId.`,
      { action: input.action, approvalId, fingerprint },
    );
  }

  if (status === "denied") {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalDenied",
      `Approval ${approvalId} was denied by the human reviewer, so nothing was executed.`,
      { action: input.action, approvalId },
    );
  }

  if (expired) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
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
      `Approval ${approvalId} was already used once and approvals are single-use, so nothing was executed. Request a fresh approval by calling this tool with no approvalId.`,
      { action: input.action, approvalId },
    );
  }

  if (status !== "approved") {
    return block(
      input.command,
      APPROVAL_PENDING_STATUS,
      "E_APPROVAL_PENDING",
      "ApprovalPending",
      `Approval ${approvalId} has not been granted yet: ${input.description} Open the approval URL and approve it, then call this tool again with the same approvalId. Nothing was executed.`,
      { action: input.action, approvalId, status: status || "pending" },
    );
  }

  return { blocked: false, approvalId };
}

export async function evaluateApproval(
  input: ApprovalGateInput,
): Promise<ApprovalGateResult> {
  const enabled = input.enabled ?? approvalGateEnabled();
  if (!enabled) return { blocked: false };

  const apiCheck = safeApiBase(resolveApiBase(input.api), input.api);

  if (!apiCheck.ok) {
    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_CONFIG",
      "ApprovalConfigError",
      apiCheck.message,
      { action: input.action },
    );
  }

  const doFetch = input.fetchImpl ?? fetch;
  const fingerprint = actionFingerprint(input.action, input.scope);

  if (!String(input.approvalId || "").trim()) {
    return requestApproval({ base: apiCheck.base, fingerprint, input, doFetch });
  }

  return verifyApproval({ base: apiCheck.base, fingerprint, input, doFetch });
}
