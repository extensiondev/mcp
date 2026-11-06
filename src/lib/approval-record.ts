// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { APPROVAL_REJECTED_STATUS } from "./approval-outcome";
import { targetServer } from "./credential-server";
import { loginIdOf, readTokenClaims, splitRef } from "./credential-source";
import { credentialsPath } from "./credentials";
import { envelope } from "./envelope";
import { withFileLock, writePrivateJson } from "./private-file";
import { currentProjectName, movedNameNote, resolveProjectIdentity, sameStoredProject, tokenProjectIdentity } from "./project-identity";

export interface MintedApproval {
  approvalId: string;
  workspace: string;
  project: string;
  projectId?: string;
  loginId?: string;
  action: string;
  fingerprint: string;
  approvalUrl: string;
  mintedAt: string;
  expiresAt: string;
  description?: string;
  replaces?: string[];
  replacedBy?: string;
}

type ApprovalFile = Record<string, Record<string, MintedApproval>>;

export const APPROVAL_RECORD_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const LONGEST_APPROVAL_TTL_SECONDS = 12 * 60 * 60;

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function approvalRecordPath(): string {
  return path.join(path.dirname(credentialsPath()), "approvals.json");
}

export function storedProjectId(api: string | undefined, ref: string): string {
  try {
    return resolveProjectIdentity(api, ref)?.projectId ?? "";
  } catch {
    return "";
  }
}

export function mintedProjectMatches(
  api: string | undefined,
  minted: Pick<MintedApproval, "workspace" | "project" | "projectId">,
  ref: string,
): boolean {
  const mintedRef = `${minted.workspace}/${minted.project}`.toLowerCase();
  const named = ref.trim().toLowerCase();
  if (!named) return false;
  if (named === mintedRef) return true;
  if (minted.projectId && storedProjectId(api, named) === minted.projectId) return true;

  return sameStoredProject(api, mintedRef, named);
}

export function renameNote(from: string, to: string): string {
  return `The project was renamed from ${from} to ${to} since the approval was minted.`;
}

function readFile(): ApprovalFile {
  try {
    const data = JSON.parse(fs.readFileSync(approvalRecordPath(), "utf8"));

    return data && typeof data === "object" && !Array.isArray(data) ? (data as ApprovalFile) : {};
  } catch {
    return {};
  }
}

function retained(record: MintedApproval, now: number): boolean {
  const expiresAt = Date.parse(record.expiresAt);

  return Number.isFinite(expiresAt) && expiresAt + APPROVAL_RECORD_RETENTION_SECONDS * 1000 > now;
}

function prune(file: ApprovalFile, now: number): ApprovalFile {
  const kept: ApprovalFile = {};

  for (const [server, records] of Object.entries(file)) {
    if (!records || typeof records !== "object") continue;

    const live = Object.entries(records).filter(([, record]) => record && typeof record === "object" && retained(record, now));
    if (live.length) kept[server] = Object.fromEntries(live);
  }

  return kept;
}

/* @invariant AN APPROVAL IS BOUND TO THE PROJECT WHOSE TOKEN MINTED IT, ON
 * THIS MACHINE, FOR AS LONG AS THE PLATFORM REMEMBERS IT. The platform keys an
 * approval by its id and answers it only to a token of the project that asked
 * for it; this server picks a call's token by the project named, or else by
 * the most recent login in a config dir several chats share. A login to
 * another project between the mint and the retry moved that default, so the
 * retry asked the platform as the wrong project and was told the id was
 * unknown. The record written here, beside the login store, names the
 * project from the minting token's own claims, so a retry without a project
 * resolves the login that minted it, whatever became active since and
 * whichever process answers. It is kept for the platform's retention after
 * the expiry (seven days), so an expired id still reaches its own project and
 * gets the platform's expired answer and a renewal, never unknown. A fresh
 * mint for the same act (same project, action and fingerprint) marks every
 * older live record of it replaced: the owner approved three approvals for
 * one configure on 2026-10-22 because nothing said the first two were stale.
 * The record also keeps the platform's own description of the act, so a
 * later call that finds the approval pending or spent repeats the words the
 * approval page shows (on 2026-10-23 a Safari upload the page called a
 * TestFlight draft was still "for store review" in the pending answer,
 * because that answer read this server's own sentence). The project is
 * bound by its prj_ id, read from the stored login the token belongs to,
 * because a rename moves the slug and not the project: the platform keeps
 * answering the approval to the same project under its new name, so a retry
 * that names the new slug is the same act, not another project's. The slugs
 * recorded are the project's current ones on this machine, not the token's
 * claims: a token minted under a slug the project has since left keeps that
 * slug in its claims for good, and a record written from them named an
 * approval minted under the new name "for" the old one and refused the retry
 * under the new name (ledger 459). The login itself is named by the token's
 * own id (a fingerprint when the claims carry none, never the token), so the
 * retry is made with the login that asked.
 */
export function rememberMintedApproval(args: {
  api?: string;
  token: string;
  projectId?: string;
  approvalId: string;
  action: string;
  fingerprint: string;
  approvalUrl: string;
  expiresAt?: string;
  description?: string;
  now?: number;
}): MintedApproval | null {
  const claims = readTokenClaims(args.token);
  const approvalId = trimmed(args.approvalId);
  if (!claims || !approvalId) return null;

  const now = args.now ?? Date.now();
  const expiresAt = Number.isFinite(Date.parse(trimmed(args.expiresAt)))
    ? new Date(Date.parse(trimmed(args.expiresAt))).toISOString()
    : new Date(now + LONGEST_APPROVAL_TTL_SECONDS * 1000).toISOString();
  const identity = tokenProjectIdentity(args.api, args.token, `${claims.workspace}/${claims.project}`);
  const [workspace = claims.workspace, project = claims.project] = identity?.current ? identity.current.split("/") : [];
  const projectId = trimmed(args.projectId) || identity?.projectId || "";
  const loginId = loginIdOf(args.token);
  const record: MintedApproval = {
    approvalId,
    workspace,
    project,
    ...(projectId ? { projectId } : {}),
    ...(loginId ? { loginId } : {}),
    action: args.action,
    fingerprint: args.fingerprint,
    approvalUrl: trimmed(args.approvalUrl),
    mintedAt: new Date(now).toISOString(),
    expiresAt,
    ...(trimmed(args.description) ? { description: trimmed(args.description) } : {}),
  };
  const server = targetServer(args.api);
  const file = approvalRecordPath();

  try {
    withFileLock(file, "approval record", () => {
      const kept = prune(readFile(), now);
      const onServer = { ...(kept[server] ?? {}) };
      const replaced = Object.values(onServer)
        .filter((older) => older.approvalId !== approvalId && !older.replacedBy && sameAct(older, record, args.api))
        .map((older) => older.approvalId);

      for (const id of replaced) onServer[id] = { ...onServer[id]!, replacedBy: approvalId };
      if (replaced.length) record.replaces = replaced;

      kept[server] = { ...onServer, [approvalId]: record };
      writePrivateJson(file, kept);
    });

    return record;
  } catch {
    return null;
  }
}

function sameProject(a: MintedApproval, b: MintedApproval, api: string | undefined): boolean {
  if (a.projectId && b.projectId) return a.projectId === b.projectId;

  return mintedProjectMatches(api, a, `${b.workspace}/${b.project}`);
}

function sameAct(a: MintedApproval, b: MintedApproval, api: string | undefined): boolean {
  return a.action === b.action && a.fingerprint === b.fingerprint && sameProject(a, b, api);
}

export function mintedApproval(api: string | undefined, approvalId: string, now = Date.now()): MintedApproval | null {
  const id = trimmed(approvalId);
  if (!id) return null;

  const record = readFile()[targetServer(api)]?.[id];

  return record && typeof record === "object" && retained(record, now) ? record : null;
}

function namedRef(named: string, record: MintedApproval): string {
  const ref = splitRef(named);

  return ref ? `${ref.workspace}/${ref.project}` : `${record.workspace}/${named.toLowerCase()}`;
}

/* @invariant A CALL THAT CARRIES AN APPROVAL ID THIS MACHINE MINTED IS MADE
 * AS THE PROJECT IT WAS MINTED FOR. With no project named, the minted project
 * is filled in by its current name before the login is picked; a project
 * named that is not the minted one is refused before the platform is asked,
 * naming both, because the platform would answer unknown and the agent would
 * read that as a lost approval. The named project is the minted one when it
 * is the same slug, when this machine's login store resolves both names to
 * one entry (the old slug stays an alias of the new one), or when the stored
 * login under that name carries the minted prj_ id: a call under the old
 * name is made as the current one and told the move, a call under the new
 * name for a record that kept the old one is told the rename; a slug this
 * machine resolves to another project, or to none, is another project. An id
 * this machine did not mint is left to the platform.
 */
export function bindApprovalProject(
  name: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; note?: string } | { refused: string } {
  const approvalId = trimmed(args.approvalId);
  if (!approvalId) return { args };

  const api = trimmed(args.api) || undefined;
  const minted = mintedApproval(api, approvalId);
  if (!minted) return { args };

  const ref = `${minted.workspace}/${minted.project}`;
  const named = trimmed(args.project);

  if (!named) return { args: { ...args, project: currentProjectName(api, ref) } };

  const wanted = namedRef(named, minted);
  if (wanted === ref) return { args };

  if (mintedProjectMatches(api, minted, wanted)) {
    const current = currentProjectName(api, wanted);

    if (current === wanted) return { args, note: renameNote(ref, current) };

    return { args: { ...args, project: current }, note: movedNameNote(wanted, current) };
  }

  return {
    refused: envelope({
      ok: false,
      command: name,
      status: APPROVAL_REJECTED_STATUS,
      value: { approvalId, mintedFor: ref, named, action: minted.action, mintedAt: minted.mintedAt },
      error: {
        code: "E_APPROVAL_REJECTED",
        name: "ApprovalOtherProject",
        message: `Approval ${approvalId} was minted for ${ref} (${minted.action}, ${minted.mintedAt}), not ${named}, so the platform was not asked and nothing was executed.`,
      },
      hint: `Call again with project: "${ref}" and the same approvalId to continue that approval, or with project: "${named}" and no approvalId to request one for ${named}.`,
    }),
  };
}
