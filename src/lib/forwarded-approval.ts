// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { storedLoginFor } from "./approval-login";
import { mintedApproval } from "./approval-record";
import { targetServer } from "./credential-server";
import { loginIdOf, resolveCredential, type CredentialRef } from "./credential-source";
import { MEMBER_PROJECT, listCredentials } from "./credentials";
import { forwardApprovalHolder, wwwApprovalState, type ApprovalHolder, type ForwardSession } from "./forward-approval-state";
import { forwardUrlFor } from "./forward-credential";
import { resolveApiBase, safeApiBase } from "./login-flow";

import type { MintedApproval } from "./approval-state";
import type { ForwarderDeps, StoredLogin } from "./hosted-forwarder";

type Args = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function refOf(ref: CredentialRef | null): string | null {
  return ref ? `${ref.workspace}/${ref.project}`.toLowerCase() : null;
}

function storedLogins(api?: string): StoredLogin[] {
  const server = targetServer(api);
  const now = Math.floor(Date.now() / 1000);

  try {
    return listCredentials()
      .filter((entry) => entry.server === server && !entry.movedTo && entry.projectSlug !== MEMBER_PROJECT && !(entry.expiresAt && entry.expiresAt <= now))
      .map((entry) => ({ token: String(entry.token).trim(), ref: { workspace: entry.workspaceSlug, project: entry.projectSlug } }));
  } catch {
    return [];
  }
}

const approvalHolders = new Map<string, string>();
const namedHolders = new Map<string, MintedApproval>();

export function forgetApprovalHolders(): void {
  approvalHolders.clear();
  namedHolders.clear();
}

/* @invariant A FORWARDED CALL THAT CARRIES AN APPROVAL ID IS MADE AS THE
 * PROJECT AND WITH THE LOGIN THE APPROVAL WAS MINTED FOR, WHEREVER ITS RECORD
 * LIVES. On the forwarder path the record is in www's hosted state, not in
 * this machine's approvals.json, and www answers it only to a credential of
 * the project that minted it. So the login the call would use is asked
 * first, then the other logins stored for that server, one at a time, the
 * same workspace before the rest, each with the forward credential this
 * process already holds for it, and the asking stops at the first that
 * reads the record. A member login is asked once per project it lists, on
 * one exchange. Which login read an id is remembered for as long as this
 * server runs, so the status poll and the act that follow cost one read
 * each. The record is handed to the dispatcher, which binds the project and
 * the login exactly as it does for a record on disk (ledger 443 and 472). A
 * record this machine holds on disk is left to the dispatcher's own read; an
 * id no stored login can read is left to the platform, and so is a record
 * read by a login that is not in the store (EXTENSION_DEV_TOKEN), because
 * that call already goes out with the login www answered. Before any of
 * that asking, the call's own login asks www once which of the person's
 * projects holds the id (ledger 733): www names the project and the login,
 * the dispatcher binds both, and no other login is exchanged for the read.
 * The act and its words stay behind the project's own door, so the record
 * handed on carries the project and the login and nothing else. When www
 * says this person holds no such approval the asking ends there, and only a
 * www that predates the door is asked login by login.
 */
export async function approvalHeldByPerson(args: Args, deps: ForwarderDeps = {}): Promise<MintedApproval | null> {
  const approvalId = text(args.approvalId);
  if (!approvalId) return null;

  const named = text(args.api) || undefined;
  if (mintedApproval(named, approvalId)) return null;

  const checked = safeApiBase(resolveApiBase(named));
  const resource = checked.ok ? forwardUrlFor(checked.base, deps.env) : null;
  if (!checked.ok || !resource) return null;

  const own = (deps.resolveLogin ?? resolveCredential)({ project: text(args.project) || undefined, api: named });
  const keyOf = (login: StoredLogin): string => `${login.token} ${refOf(login.ref) ?? ""}`;
  const held = `${checked.base} ${approvalId}`;
  const sessionOf = (login: StoredLogin): ForwardSession => ({ api: checked.base, login: login.token, project: refOf(login.ref), resource, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  const ownHit = (found: MintedApproval): MintedApproval | null => (storedLoginFor(found, named) ? found : null);
  const namedHolder = namedHolders.get(held);

  if (namedHolder) return namedHolder;

  const asked: ApprovalHolder = own.token && !approvalHolders.has(held) ? await forwardApprovalHolder(sessionOf(own), approvalId) : { kind: "unanswered" };

  if (asked.kind === "unknown") return null;

  if (asked.kind === "record") {
    approvalHolders.set(held, keyOf(own));

    return ownHit(asked.record);
  }

  if (asked.kind === "holder") {
    const found: MintedApproval = { approvalId, workspace: asked.workspace, project: asked.project, loginId: asked.loginId, action: "", fingerprint: "", approvalUrl: "", mintedAt: "", expiresAt: "" };
    const bound = refOf(own.ref) === `${asked.workspace}/${asked.project}` && loginIdOf(own.token) === asked.loginId ? ownHit(found) : found;

    if (bound) namedHolders.set(held, bound);

    return bound;
  }

  const walked = own.token && !approvalHolders.has(held);
  const rank = (login: StoredLogin): number => (keyOf(login) === approvalHolders.get(held) ? 0 : login === own ? 1 : login.ref?.workspace.toLowerCase() === own.ref?.workspace.toLowerCase() ? 2 : 3);
  const known = new Set<string>();
  const logins = [own, ...(deps.storedLogins ?? storedLogins)(named)]
    .filter((login) => {
      if (!login.token || known.has(keyOf(login))) return false;

      known.add(keyOf(login));

      return !(walked && login === own);
    })
    .sort((a, b) => rank(a) - rank(b));

  for (const login of logins) {
    const found = await wwwApprovalState(sessionOf(login)).mintedApproval(checked.base, approvalId);
    if (!found) continue;

    approvalHolders.set(held, keyOf(login));

    return login === own ? ownHit(found) : found;
  }

  return null;
}
