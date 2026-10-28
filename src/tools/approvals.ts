// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { approvalUrlFor } from "../lib/approval-outcome";
import { readJson } from "../lib/approval-verify";
import { API_BASE } from "../lib/common-schema";
import { LOGIN_STEPS, PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import { resolveToken } from "../lib/publish";

const COMMAND = "extension_approvals";
const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{32}$/;

export const schema = {
  name: COMMAND,
  description:
    "Read or revoke one approval a workspace owner was asked for on extension.dev. action status (the default) answers where the approval stands: pending, approved and unused, used, declined, revoked or expired. action revoke takes back a pending approval, or one that was approved and not used yet, so no act can ever run with it; only a token minted by a workspace owner may revoke, nothing else changes, and an approval that already ran is refused with what it ran. Use revoke when the person says they approved something by mistake or no longer wants it to happen. The answer reports what the platform recorded after the revoke in value.outcome and the approval page in value.links.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "revoke"],
        default: "status",
        description: "status reads the approval; revoke ends a pending or approved, unused approval for good.",
      },
      approvalId: {
        type: "string",
        description: "The approval, apr_ followed by 32 characters, as an approval-required answer or the approval page link gave it.",
      },
      project: PROJECT_TOKEN_INPUT,
      api: API_BASE,
    },
    required: ["approvalId"],
  },
};

type Read = { status: number; held: boolean; data: Record<string, unknown> } | { error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unchanged(message: string): string {
  return /Nothing changed\.$/.test(message) ? message : `${message} Nothing changed.`;
}

function refused(status: string, name: string, message: string, value: Record<string, unknown>, hint?: string): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status,
    value,
    error: { code: name === "ApprovalsAuthError" ? "E_AUTH_REQUIRED" : name === "ApprovalsInputError" ? "E_BAD_REQUEST" : "E_PLATFORM", name, message },
    ...(hint ? { hint } : {}),
  });
}

async function ask(base: string, path: string, method: "GET" | "POST", token: string): Promise<Read> {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const data = await readJson(res);

    return { status: res.status, held: sawPlatformHold(res, data), data };
  } catch (err: any) {
    return { error: String(err?.message || err) };
  }
}

function standing(read: { status: number; data: Record<string, unknown> }): string {
  const code = text(read.data.code);

  if (code === "APPROVAL_REVOKED") return "revoked";
  if (code === "APPROVAL_EXPIRED") return "expired";
  if (code === "APPROVAL_REPLACED") return "replaced";
  if (read.status !== 200) return "";

  const status = text(read.data.status).toLowerCase();

  if (status === "approved" && read.data.used === true) return "used";
  if (status === "approved") return "approved-unused";

  return status;
}

const SAY: Record<string, string> = {
  pending: "It waits for a workspace owner; revoke ends it before anyone approves.",
  "approved-unused": "It is approved and has not run yet; revoke takes it back so it never runs.",
  used: "It already ran once; approvals are single-use, so there is nothing to revoke.",
  denied: "It was declined, so it can never run.",
  revoked: "It was revoked, so it can never run.",
  expired: "It expired, so it can never run.",
  replaced: "A newer request for the same change replaced it, so it can never run.",
};

export async function handler(args: { action?: string; approvalId?: string; project?: string; api?: string }): Promise<string> {
  const action = text(args.action) || "status";
  const approvalId = text(args.approvalId);
  const value = { action, approvalId };

  if (action !== "status" && action !== "revoke") {
    return refused("bad-request", "ApprovalsInputError", `Unknown action ${JSON.stringify(action)}. Use status or revoke.`, value);
  }

  if (!APPROVAL_ID.test(approvalId)) {
    return refused(
      "bad-request",
      "ApprovalsInputError",
      approvalId
        ? `${JSON.stringify(approvalId.slice(0, 80))} is not an approval id, so nothing was sent to the platform. An approval id is apr_ followed by 32 characters.`
        : "Pass approvalId, the apr_ id an approval-required answer or the approval page link gave. Nothing was sent to the platform.",
      value,
    );
  }

  const token = resolveToken({ project: args.project, api: args.api });

  if (!token) {
    return refused(
      "auth-required",
      "ApprovalsAuthError",
      args.project ? noStoredLoginHint(args.project) : "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN.",
      value,
      LOGIN_STEPS,
    );
  }

  const api = safeApiBase(resolveApiBase(args.api), args.api);

  if (!api.ok) return refused("config-error", "ApprovalsConfigError", api.message, value);

  const approvalUrl = approvalUrlFor(approvalId, args.api);
  const links = [{ kind: "approval", url: approvalUrl, audience: "workspace", expiresAt: null, made: false }];
  const path = `/api/cli/approvals/${encodeURIComponent(approvalId)}`;
  const unreachable = (detail: string, status: string) =>
    refused(status, "ApprovalsUnreachable", `The platform could not be reached (${detail}), so whether this approval was changed is unknown.`, { ...value, approvalUrl }, `Call extension_approvals (action: status, approvalId: ${approvalId}) to read where it stands.`);
  const held = (read: { data: Record<string, unknown> }) =>
    platformHoldEnvelope({ command: COMMAND, name: "ApprovalsHeld", body: read.data, api: args.api, value });

  if (action === "status") {
    const read = await ask(api.base, path, "GET", token);

    if ("error" in read) return unreachable(read.error, "unavailable");
    if (read.held) return held(read);

    const state = standing(read);

    if (!state) {
      return refused(
        read.status === 404 ? "not-found" : "unavailable",
        "ApprovalsReadError",
        text(read.data.message) || `The platform answered ${read.status}.`,
        { ...value, ...(text(read.data.code) ? { platformCode: text(read.data.code) } : {}) },
        read.status === 404 ? "The platform does not know this approval for the project this login is scoped to; pass project to read it with another login." : undefined,
      );
    }

    return envelope({
      ok: true,
      command: COMMAND,
      status: state,
      value: { ...value, ...read.data, approvalUrl, links },
      hint: `${SAY[state] ?? ""} The approval page is ${approvalUrl}.`.trim(),
    });
  }

  const sent = await ask(api.base, `${path}/revoke`, "POST", token);

  if ("error" in sent) return unreachable(sent.error, "revoke-unconfirmed");
  if (sent.held) return held(sent);

  if (sent.status !== 200) {
    const code = text(sent.data.code);
    const { message: _message, code: _code, ...detail } = sent.data;

    return refused(
      "revoke-refused",
      code === "OWNER_REQUIRED" || code === "TOKEN_ISSUER_UNKNOWN" ? "ApprovalsOwnerRequired" : "ApprovalsRevokeRefused",
      unchanged(text(sent.data.message) || `The platform answered ${sent.status}.`),
      { ...value, ...detail, ...(code ? { platformCode: code } : {}), approvalUrl, links },
      code === "APPROVAL_USED"
        ? "Tell the person it already ran, and what it ran. Undoing the act itself is that act's own tool (for a store submission, extension_submit action:'cancel')."
        : code === "OWNER_REQUIRED" || code === "TOKEN_ISSUER_UNKNOWN"
          ? "Only a workspace owner may revoke. Ask an owner to open the approval page and press Revoke, or to run this with a token they minted."
          : undefined,
    );
  }

  const check = await ask(api.base, path, "GET", token);
  const recorded = !("error" in check) && !check.held && text(check.data.code) === "APPROVAL_REVOKED";
  const outcome = {
    recorded,
    status: recorded ? "revoked" : "revoke-unconfirmed",
    checkedAt: new Date().toISOString(),
    source: "approval-read",
    ...("error" in check ? { readProblem: check.error } : {}),
  };
  const revokedBy = text(sent.data.revokedBy);
  const revokedAt = text(sent.data.revokedAt);
  const description = text(sent.data.description);

  return envelope({
    ok: true,
    command: COMMAND,
    status: recorded ? "revoked" : "revoke-unconfirmed",
    value: {
      ...value,
      revoked: recorded,
      ...(text(sent.data.kind) ? { kind: text(sent.data.kind) } : {}),
      ...(description ? { description } : {}),
      ...(revokedBy ? { revokedBy } : {}),
      ...(revokedAt ? { revokedAt } : {}),
      approvalUrl,
      outcome,
      links,
    },
    hint: recorded
      ? `Revoked${revokedBy ? ` by ${revokedBy}` : ""}${revokedAt ? ` at ${revokedAt}` : ""}: ${description ? `"${description}"` : "the act it covered"} can never run with this approval, and nothing ran. Made: nothing; the approval page ${approvalUrl} now reads Revoked.`
      : `The platform accepted the revoke but reading the approval back did not confirm it yet. Call extension_approvals (action: status, approvalId: ${approvalId}) before telling the person it is revoked.`,
  });
}
