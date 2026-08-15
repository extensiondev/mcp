// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import { envelope } from "./envelope";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { platformHoldEnvelope, sawPlatformHold } from "./platform-hold";

/* @invariant
 * THIS IS THE HUMAN-IN-THE-LOOP GATE FOR IRREVERSIBLE, OUTWARD ACTIONS, AND
 * THE LOCAL HALF CANNOT SELF-APPROVE.
 *
 * The Stripe-MCP insight: an agent may reach a store submission, a channel
 * promotion, or a permanent delete with no human in the loop. This gate puts
 * one there. It defends the boundary between an agent's intent and an action a
 * human cannot take back, against a principal that is the agent itself acting
 * on bad input, a poisoned README, or a compromised session.
 *
 * The whole point is that the LOCAL MCP HAS NO AUTHORITY TO APPROVE. It holds
 * no signing key and mints no grant. Approval is a record the server creates
 * and a human turns from pending to approved at extension.dev while signed in
 * with the same device-auth identity every other lane uses. So the gate here
 * is a relay and a fail-closed guard, never the decision.
 *
 * Two-phase flow, both phases below:
 *   1. First call with no approvalId: the gate POSTs a pending approval to the
 *      server bound to (action, fingerprint, scope, description) and returns an
 *      approval-required envelope carrying the approvalId and the approvalUrl a
 *      human opens. IT DOES NOT EXECUTE. If the server cannot mint one, the
 *      gate still refuses; it never proceeds.
 *   2. Second call with the approvalId: the gate GETs the approval, and only
 *      proceeds when the server says approved AND the fingerprint it stored
 *      equals the fingerprint recomputed from THIS call's action and args AND
 *      the grant is unused and unexpired. A grant minted for one action can
 *      never authorize another because the fingerprint would not match. On any
 *      doubt, network failure, or absent endpoint, it refuses. Fail closed.
 *
 * The tool then carries the approvalId on its own mutating request so the
 * SERVER performs the authoritative single-use consume at the moment it acts,
 * closing the gap between this verify and that write. The client check is for a
 * legible refusal and fail-closed safety; the server is the source of truth.
 *
 * SERVER CONTRACT (www owes this; stubbed behind EXTENSION_DEV_APPROVAL_GATE
 * until it ships, default off so nothing changes for users meanwhile):
 *
 *   POST {base}/api/cli/approvals
 *     auth: Bearer <device-auth project token>
 *     body: { action, fingerprint, scope, description }
 *     201:  { approvalId, approvalUrl, expiresAt }
 *     The server stores the fingerprint, the scope, the description, the
 *     approver-to-be (from the token's project) and a short TTL. approvalId is
 *     server-minted high-entropy; it is a handle, not a bearer secret, and is
 *     inert without the project token. approvalUrl shows the human the exact
 *     described action before they approve, under their extension.dev session.
 *     While the public hold is on, this route refuses with PLATFORM_NOT_OPEN.
 *
 *   GET {base}/api/cli/approvals/{approvalId}
 *     auth: Bearer <device-auth project token>
 *     200:  { status, fingerprint, expiresAt, used, approver? }
 *           status is "pending" | "approved" | "denied" | "expired".
 *     404:  unknown approvalId, or the endpoint is not implemented yet.
 *
 *   The mutating endpoints (/api/cli/stores/submit with dryRun:false,
 *   /api/cli/release/promote, DELETE /api/artifacts/{id}) re-verify the same
 *   grant and consume it single-use before acting, recomputing the fingerprint
 *   from the request body server-side. The client fingerprint is never trusted;
 *   it is recomputed and compared on both ends.
 *
 *   FINGERPRINT: sha256hex( action + "\n" + canonicalScope ), where
 *   canonicalScope sorts the scope keys, renders each as "key=value", joins an
 *   array value as its elements sorted and comma-joined, and joins the pairs
 *   with "\n". Callers normalize values (lowercased sha, defaulted channel,
 *   sorted browsers) BEFORE handing the scope in, so both ends hash the same
 *   bytes. The action is part of the hash so a submit grant cannot promote and
 *   a promote grant cannot delete.
 */

export const APPROVAL_GATE_ENV = "EXTENSION_DEV_APPROVAL_GATE";

export const APPROVAL_REQUIRED_STATUS = "approval-required";
export const APPROVAL_PENDING_STATUS = "approval-pending";
export const APPROVAL_REJECTED_STATUS = "approval-rejected";

export function approvalGateEnabled(): boolean {
  const raw = String(process.env[APPROVAL_GATE_ENV] || "")
    .trim()
    .toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "off";
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
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { message: text };
  } catch {
    return { message: text };
  }
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
    typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
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
