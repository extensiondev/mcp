// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { approvalUrlFor } from "./approval-outcome";
import { verdictOfAction } from "./approval-policy";
import { mintedApproval, rememberMintedApproval } from "./approval-record";
import { readApprovalSubject } from "./approval-subject";
import { envelope } from "./envelope";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { platformHoldEnvelope, sawPlatformHold } from "./platform-hold";
import {
  APPROVAL_EXPIRED_STATUS,
  APPROVAL_REJECTED_STATUS,
  APPROVAL_REQUIRED_STATUS,
  actionPhrase,
  block,
  readJson,
  verifyApproval,
  type ApprovalGateInput,
  type ExpiredApproval,
  type ApprovalGateResult,
  type ApprovalScope,
} from "./approval-verify";

export {
  APPROVAL_PENDING_STATUS,
  APPROVAL_REJECTED_STATUS,
  APPROVAL_REQUIRED_STATUS,
  type ApprovalGateInput,
  type ApprovalGateResult,
  type ApprovalScope,
} from "./approval-verify";

export const APPROVAL_GATE_ENV = "EXTENSION_DEV_APPROVAL_GATE";

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
    platformAsked: true,
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

async function requestApproval(params: {
  base: string;
  fingerprint: string;
  input: ApprovalGateInput;
  doFetch: typeof fetch;
  renewing?: ExpiredApproval;
}): Promise<{ blocked: true; envelope: string }> {
  const { base, fingerprint, input, doFetch, renewing } = params;
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
        ...(input.body ?? {}),
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
      `A human must approve ${actionPhrase(input)} before it runs, and the approval could not be requested from ${url}: ${
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

  if (!res.ok && data.refusedBeforeApproval === true) {
    const platformCode = typeof data.code === "string" ? data.code : "";
    const hint = platformCode ? input.refusalHint?.(platformCode) : undefined;
    const reason = typeof data.message === "string" && data.message ? data.message : "no reason given";
    const message = `The platform refused this action before asking anyone to approve it (${res.status}): ${reason} Nothing was executed and no approval was requested, so fix the cause and call again.`;

    return {
      blocked: true,
      envelope: envelope({
        ok: false,
        command: input.command,
        status: input.refusedStatus || "action-refused",
        value: { action: input.action, description: input.description },
        error: { code: "E_PLATFORM", name: "ActionRefused", message, ...(platformCode ? { platformCode } : {}) },
        ...(hint ? { hint } : {}),
      }),
    };
  }

  if (!res.ok) {
    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRequired",
      `A human must approve ${actionPhrase(input)} before it runs. The platform did not create an approval request (${res.status}): ${
        typeof data.message === "string" && data.message
          ? data.message
          : "no approval endpoint answered"
      }. Nothing was executed.`,
      { action: input.action, fingerprint, description: input.description },
    );
  }

  const approvalId = String(data.approvalId || "").trim();
  const approvalUrl = String(data.approvalUrl || "").trim();
  const described = typeof data.description === "string" && data.description.trim() ? data.description.trim() : input.description;
  const subject = readApprovalSubject(data.subject);

  if (!approvalId) {
    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRequestUnconfirmed",
      `A human must approve ${actionPhrase(input)} before it runs, and the platform answered the approval request (${res.status}) without an approval id, so no approval is known to exist. Nothing was executed; call this tool again to request one.`,
      { action: input.action, fingerprint, description: input.description },
    );
  }

  const remembered = rememberMintedApproval({
    api: input.api,
    token: input.token,
    approvalId,
    action: input.action,
    fingerprint,
    approvalUrl,
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
    description: described,
  });
  const replaces = remembered?.replaces?.length ? { replaces: remembered.replaces } : {};

  if (renewing) {
    const expiredAt = renewing.expiresAt || "its expiry";
    const say = `That approval expired at ${expiredAt}; here is a fresh one: ${approvalUrl}. Click Approve, then tell me.`;

    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRenewed",
      `Approval ${renewing.approvalId} expired at ${expiredAt}, so nothing was executed. A fresh approval for the same act was requested: ${described} Open ${approvalUrl} to review and approve, then call this tool again with the same arguments and approvalId ${approvalId}.`,
      {
        action: input.action,
        fingerprint,
        description: described,
        approvalId,
        approvalUrl,
        ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
        ...(subject ? { subject } : {}),
        ...(Array.isArray(data.changes) ? { changes: data.changes.filter((line) => typeof line === "string") } : {}),
        ...replaces,
        expiredApproval: { approvalId: renewing.approvalId, status: APPROVAL_EXPIRED_STATUS, ...(renewing.expiresAt ? { expiresAt: renewing.expiresAt } : {}) },
        nextStep: { kind: "approve", say, url: approvalUrl },
      },
      say,
    );
  }

  return block(
    input.command,
    APPROVAL_REQUIRED_STATUS,
    "E_APPROVAL_REQUIRED",
    "ApprovalRequired",
    `${described} ${input.reason ?? (input.irreversible ? "This is irreversible, so a human must approve it first." : "A human must approve it first.")} Open ${
      approvalUrl || "the approval URL"
    } to review and approve, then call this tool again with the same arguments and approvalId ${
      approvalId || "<from the response>"
    }. Nothing was executed.`,
    {
      action: input.action,
      fingerprint,
      description: described,
      ...(approvalId ? { approvalId } : {}),
      ...(approvalUrl ? { approvalUrl } : {}),
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
      ...(subject ? { subject } : {}),
      ...(Array.isArray(data.changes) ? { changes: data.changes.filter((line) => typeof line === "string") } : {}),
      ...replaces,
    },
    approvalUrl
      ? `Approve at ${approvalUrl}, then re-run with the same arguments and approvalId ${approvalId}.`
      : undefined,
  );
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
    const verdict = verdictOfAction(input.action, input.write);

    if (verdict === "console") {
      return block(
        input.command,
        input.refusedStatus || "console-only",
        "E_CONSOLE_ONLY",
        "ConsoleOnly",
        `${input.description} This is a person's act in the extension.dev console and never runs from here, so no approval was requested and nothing was executed.`,
        { action: input.action, description: input.description },
      );
    }

    if (verdict === "plain" && !input.platformAsked) return { blocked: false };

    return requestApproval({ base: apiCheck.base, fingerprint, input, doFetch });
  }

  const minted = mintedApproval(input.api, String(input.approvalId));

  if (minted?.replacedBy) {
    const current = mintedApproval(input.api, minted.replacedBy);
    const ref = `${minted.workspace}/${minted.project}`;
    const url = current?.approvalUrl || approvalUrlFor(minted.replacedBy, input.api);

    return block(
      input.command,
      APPROVAL_REJECTED_STATUS,
      "E_APPROVAL_REJECTED",
      "ApprovalReplaced",
      `Approval ${minted.approvalId} was replaced by ${minted.replacedBy}, a fresh approval of the same act for ${ref} requested${current ? ` at ${current.mintedAt}` : ""}, so it was not presented to the platform and nothing was executed. A person approves the current one at ${url}; then call again with the same arguments and approvalId ${minted.replacedBy}.`,
      { action: input.action, approvalId: minted.approvalId, replacedBy: minted.replacedBy, approvalUrl: url },
      `Call again with approvalId ${minted.replacedBy} once ${url} is approved; do not request another approval while it waits.`,
    );
  }

  return verifyApproval({
    base: apiCheck.base,
    fingerprint,
    input,
    doFetch,
    minted,
    renew: (expired) => requestApproval({ base: apiCheck.base, fingerprint, input, doFetch, renewing: expired }),
  });
}
