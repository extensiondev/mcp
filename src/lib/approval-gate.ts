// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { APPROVAL_GATE_ENV, approvalGateEnabled } from "./approval-gate-env";
import { readLines } from "./approval-lines";
import { loginRefusedBeforeApproval } from "./approval-login";
import { approvalUrlFor } from "./approval-outcome";
import { verdictOfAction } from "./approval-policy";
import { mintedApproval, rememberMintedApproval, standingApprovalForAct } from "./approval-record";
import { readApprovalSubject } from "./approval-subject";
import { envelope } from "./envelope";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { platformHoldEnvelope, readUpgradeUrl, sawPlatformHold } from "./platform-hold";
import { bearerHeaders } from "./request-fetch";
import {
  APPROVAL_EXPIRED_STATUS,
  APPROVAL_PENDING_STATUS,
  APPROVAL_REJECTED_STATUS,
  APPROVAL_REQUIRED_STATUS,
  actionPhrase,
  block,
  readJson,
  verifyApproval,
  withoutClosingStop,
  type ApprovalGateInput,
  type ExpiredApproval,
  type ApprovalGateResult,
  type ApprovalScope,
} from "./approval-verify";
import { SAFARI_RELEASE_ON_SALE } from "./safari-release-intent";

function renderedArgs(args: Record<string, unknown>): string {
  return `{${Object.entries(args)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ")}}`;
}

/* @invariant THE NEXT CALL IS NAMED WITH ITS TOOL. An approval asked through
 * a read-only alias such as extension_submit_check answered "call this tool
 * again", which that alias refuses (ledger 410). The sentence names the tool
 * whose handler ran, with the exact arguments when the caller gave them, and
 * the read that tells whether the owner has approved.
 */
export function nextCallSentence(input: Pick<ApprovalGateInput, "command" | "nextCall">, approvalId: string): string {
  return input.nextCall
    ? `${input.nextCall.tool} ${renderedArgs({ ...input.nextCall.args, approvalId })}`
    : `${input.command} with the same arguments and approvalId ${approvalId}`;
}

export function approvalLandedSentence(input: Pick<ApprovalGateInput, "nextCall">, approvalId: string): string {
  const waits = input.nextCall?.waits ? `, and that ${input.nextCall.tool} call with waitSeconds waits for the approval before it runs` : "";

  return `extension_approvals {action: "status", approvalId: "${approvalId}"} reads whether a workspace owner has approved it${waits}.`;
}

function statusOf(out: string): string {
  try {
    const parsed = JSON.parse(out) as { status?: unknown };

    return typeof parsed.status === "string" ? parsed.status : "";
  } catch {
    return "";
  }
}

function unsaid(described: string, reason: string): string {
  const sentences = reason.split(/(?<=\.)\s+/);
  const onSaleSaid = SAFARI_RELEASE_ON_SALE.test(described);
  const kept = sentences.filter((sentence) => !described.includes(sentence.trim()) && !(onSaleSaid && SAFARI_RELEASE_ON_SALE.test(sentence)));

  return kept.join(" ");
}

export {
  APPROVAL_PENDING_STATUS,
  APPROVAL_REJECTED_STATUS,
  APPROVAL_REQUIRED_STATUS,
  type ApprovalGateInput,
  type ApprovalGateResult,
  type ApprovalScope,
} from "./approval-verify";

export { APPROVAL_GATE_ENV, approvalGateEnabled };

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

  if (gate.blocked) return gate.envelope;

  if (gate.approvalId) {
    const approvalUrl = mintedApproval(input.api, gate.approvalId)?.approvalUrl || approvalUrlFor(gate.approvalId, input.api);

    return envelope({
      ok: false,
      command: input.command,
      status: APPROVAL_REQUIRED_STATUS,
      value: { action: input.action, description: input.description, approvalId: gate.approvalId, approvalUrl },
      error: {
        code: "E_APPROVAL_REQUIRED",
        name: "ApprovalAlreadyGranted",
        message: `Approval ${gate.approvalId} for this exact act is already approved and unspent, and this call did not carry it, so nothing was executed. Call ${nextCallSentence(input, gate.approvalId)} to run it.`,
      },
      hint: `Approval ${gate.approvalId} stands approved; ${nextCallSentence(input, gate.approvalId)} runs it. Do not request a fresh approval.`,
    });
  }

  return envelope({
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
        ...bearerHeaders(input.token, input.ref),
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

  if (res.status === 401) {
    return loginRefusedBeforeApproval(input, res.status, typeof data.message === "string" ? withoutClosingStop(data.message) : "");
  }

  if (!res.ok && data.refusedBeforeApproval === true) {
    const platformCode = typeof data.code === "string" ? data.code : "";
    const hint = platformCode ? input.refusalHint?.(platformCode, data) : undefined;
    const upgradeUrl = readUpgradeUrl(data);
    const reason = typeof data.message === "string" && data.message ? data.message : "no reason given";
    const message = `The platform refused this action before asking anyone to approve it (${res.status}): ${reason} Nothing was executed and no approval was requested, so fix the cause and call again.`;

    return {
      blocked: true,
      envelope: envelope({
        ok: false,
        command: input.command,
        status: input.refusedStatus || "action-refused",
        value: {
          action: input.action,
          description: input.description,
          ...(Array.isArray(data.stores) ? { stores: data.stores } : {}),
          ...(upgradeUrl ? { upgradeUrl } : {}),
        },
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
  const lines = readLines(data.lines);
  const lined = lines.length ? { lines } : {};

  if (!approvalId) {
    return block(
      input.command,
      APPROVAL_REQUIRED_STATUS,
      "E_APPROVAL_REQUIRED",
      "ApprovalRequestUnconfirmed",
      `A human must approve ${actionPhrase(input)} before it runs, and the platform answered the approval request (${res.status}) without an approval id, so no approval is known to exist. Nothing was executed; call ${input.command} again to request one.`,
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
      `Approval ${renewing.approvalId} expired at ${expiredAt}, so nothing was executed. A fresh approval for the same act was requested: ${described} Open ${approvalUrl} to review and approve, then call ${nextCallSentence(input, approvalId)}. ${approvalLandedSentence(input, approvalId)}`,
      {
        action: input.action,
        fingerprint,
        description: described,
        approvalId,
        approvalUrl,
        ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
        ...(subject ? { subject } : {}),
        ...(Array.isArray(data.changes) ? { changes: data.changes.filter((line) => typeof line === "string") } : {}),
        ...lined,
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
    `${described} ${unsaid(described, input.reason ?? (input.irreversible ? "This is irreversible, so a human must approve it first." : "A human must approve it first."))} Open ${
      approvalUrl || "the approval URL"
    } to review and approve, then call ${nextCallSentence(input, approvalId || "<from the response>")}. ${approvalLandedSentence(input, approvalId || "<from the response>")} Nothing was executed.`,
    {
      action: input.action,
      fingerprint,
      description: described,
      ...(approvalId ? { approvalId } : {}),
      ...(approvalUrl ? { approvalUrl } : {}),
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
      ...(subject ? { subject } : {}),
      ...(Array.isArray(data.changes) ? { changes: data.changes.filter((line) => typeof line === "string") } : {}),
      ...lined,
      ...replaces,
    },
    approvalUrl
      ? `Approve at ${approvalUrl}; then ${nextCallSentence(input, approvalId)} runs it. ${approvalLandedSentence(input, approvalId)}${lines.length > 1 ? " The page lists one line per store; a store unchecked there is left out." : ""}`
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

    const standing = standingApprovalForAct({ api: input.api, token: input.token, action: input.action, fingerprint, now: input.now });

    if (standing) {
      const held = await verifyApproval({ base: apiCheck.base, fingerprint, input: { ...input, approvalId: standing.approvalId }, doFetch, minted: standing });
      if (!held.blocked) return { blocked: false, approvalId: standing.approvalId };
      if (statusOf(held.envelope) === APPROVAL_PENDING_STATUS) return held;
    }

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
