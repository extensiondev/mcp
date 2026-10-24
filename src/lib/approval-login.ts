// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { mintedApproval, type MintedApproval } from "./approval-record";
import { requestCredential } from "./credential-scope";
import { loginKey, serverOf, targetServer } from "./credential-server";
import { loginIdOf, readTokenClaims } from "./credential-source";
import { readCredentialStore, type StoredCredentials } from "./credentials";
import { envelope } from "./envelope";
import { trackUrl } from "./track-url";

import type { ApprovalGateInput } from "./approval-verify";

const AUTH_REQUIRED_STATUS = "auth-required";

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/* @invariant A RETRY THAT CARRIES AN APPROVAL ID IS MADE WITH THE LOGIN THAT
 * REQUESTED THE APPROVAL. The record of a mint names the login by the token's
 * own id, and the stored login with that id is the bearer of the retry,
 * whatever login became active in the shared store since and whichever
 * process answers; the project's other logins (same prj_ id, then the same
 * slug) stand in only when that login is gone, because the platform answers
 * the approval to any token of the project. A record whose project has no
 * stored login left is answered here, before the platform is asked, with the
 * sign-in sentence, never with the platform's 401 for a token of another
 * project. A hosted request carries its own token and is not rebound.
 */
export function storedLoginFor(
  record: Pick<MintedApproval, "loginId" | "workspace" | "project" | "projectId">,
  api?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): StoredCredentials | null {
  const store = readCredentialStore();
  if (!store) return null;

  const server = targetServer(api);
  const live = Object.entries(store.entries).filter(
    ([, entry]) => serverOf(entry.api) === server && !entry.movedTo && !(entry.expiresAt && entry.expiresAt <= nowSeconds),
  );
  const byId = record.loginId ? live.find(([, entry]) => loginIdOf(entry.token) === record.loginId) : undefined;
  const byProjectId = record.projectId ? live.find(([, entry]) => entry.projectId === record.projectId) : undefined;
  const key = loginKey(record.workspace, record.project, server);
  const bySlug = live.find(([name]) => name === key);

  return (byId ?? byProjectId ?? bySlug)?.[1] ?? null;
}

export function bindApprovalLogin(
  name: string,
  args: Record<string, unknown>,
): { login: StoredCredentials | null } | { refused: string } {
  const approvalId = trimmed(args.approvalId);
  if (!approvalId || requestCredential()) return { login: null };

  const api = trimmed(args.api) || undefined;
  const minted = mintedApproval(api, approvalId);
  if (!minted) return { login: null };

  const login = storedLoginFor(minted, api);
  if (login) return { login };

  const ref = `${minted.workspace}/${minted.project}`;

  return {
    refused: envelope({
      ok: false,
      command: name,
      status: AUTH_REQUIRED_STATUS,
      value: {
        approvalId,
        mintedFor: ref,
        action: minted.action,
        mintedAt: minted.mintedAt,
        trackUrl: trackUrl("project", { workspace: minted.workspace, project: minted.project }, api),
      },
      error: {
        code: "E_AUTH_REQUIRED",
        name: "ApprovalLoginGone",
        message: `Approval ${approvalId} was requested for ${ref} (${minted.action}, ${minted.mintedAt}), and the login that requested this approval is no longer stored; sign in to ${ref} again and request a new approval. The platform was not asked and nothing was executed.`,
      },
      hint: `Run extension_auth (action: login, project: "${ref}"), then call this tool again with the same arguments and no approvalId.`,
    }),
  };
}

function loginRef(token: string): string {
  const claims = readTokenClaims(token);

  return claims ? `${claims.workspace}/${claims.project}` : "";
}

function loginPage(ref: string, api?: string): string {
  const [workspace = "", project = ""] = ref.split("/");

  return trackUrl(workspace ? "project" : "console", { workspace, project }, api);
}

/* @invariant A 401 FROM THE PLATFORM IS THE LOGIN'S REFUSAL, NEVER THE
 * APPROVAL'S. The approval request and the approval confirmation both carry a
 * bearer, and the platform refuses an untracked bearer with 401 before it
 * reads any approval. Answering that as "request a fresh approval" sent an
 * agent to mint again with the same refused login (ledger 153: the Edge
 * submit confirmation of 2026-10-24 was refused with 401 while the platform's
 * token-record read was out of budget, with the approval valid and the login
 * stored). The answer names the login the platform refused and what was not
 * done: before an approval, that none was requested; on a confirmation, that
 * the approval was not consulted and the id is kept for the next call.
 */
export function loginRefusedBeforeApproval(
  input: Pick<ApprovalGateInput, "command" | "action" | "description" | "token" | "api">,
  status: number,
  reason: string,
): { blocked: true; envelope: string } {
  const ref = loginRef(input.token);
  const who = ref ? `the login this call used for ${ref}` : "the login this call used";

  return {
    blocked: true,
    envelope: envelope({
      ok: false,
      command: input.command,
      status: AUTH_REQUIRED_STATUS,
      value: {
        action: input.action,
        description: input.description,
        ...(ref ? { login: ref } : {}),
        trackUrl: loginPage(ref, input.api),
      },
      error: {
        code: "E_AUTH_REQUIRED",
        name: "LoginRefused",
        message: `The platform did not recognize ${who} (${status}): ${reason || "no reason given"}. No approval was requested and nothing was executed.`,
      },
      hint: ref
        ? `Call again once; if the platform still refuses the login, run extension_auth (action: login, project: "${ref}") and call again.`
        : "Call again once; if the platform still refuses the login, run extension_auth (action: login) and call again.",
    }),
  };
}

export function loginRefusedOnApproval(args: {
  input: Pick<ApprovalGateInput, "command" | "action" | "token" | "api">;
  approvalId: string;
  fingerprint: string;
  status: number;
  reason: string;
  minted?: MintedApproval | null;
}): { blocked: true; envelope: string } {
  const { input, approvalId, minted } = args;
  const ref = loginRef(input.token) || (minted ? `${minted.workspace}/${minted.project}` : "");
  const kept = minted?.expiresAt ? ` until ${minted.expiresAt}` : "";

  return {
    blocked: true,
    envelope: envelope({
      ok: false,
      command: input.command,
      status: AUTH_REQUIRED_STATUS,
      value: {
        action: input.action,
        approvalId,
        fingerprint: args.fingerprint,
        ...(ref ? { login: ref } : {}),
        ...(minted ? { mintedFor: `${minted.workspace}/${minted.project}` } : {}),
        trackUrl: loginPage(ref, input.api),
      },
      error: {
        code: "E_AUTH_REQUIRED",
        name: "ApprovalLoginRefused",
        message: `The platform did not recognize the login that requested approval ${approvalId}${ref ? ` for ${ref}` : ""} (${args.status}): ${args.reason || "no reason given"}. The approval itself was not consulted and nothing was executed; it stays as the owner left it${kept}.`,
      },
      hint: `Call again with the same arguments and approvalId ${approvalId} once the platform recognizes the login; if it keeps refusing it, run extension_auth (action: login${ref ? `, project: "${ref}"` : ""}) and request a fresh approval by calling with no approvalId.`,
    }),
  };
}
