// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { serverOf, targetServer } from "./credential-server";
import { loginEntries, readCredentialStore, readCredentials } from "./credentials";

export interface ProjectIdentity {
  current: string;
  projectId: string;
  movedFrom: string | null;
}

/* @invariant EVERY NAME THIS MACHINE KNOWS FOR A PROJECT RESOLVES TO THE SAME
 * PROJECT. A rename on the platform moves the slug and not the project; the
 * login store keeps the entry under the current slug and the old slug as an
 * alias of it, while a token's own claims keep the slug it was minted under
 * for good. Every place that compares or keys a project by name (the login
 * lookup, the approval record and its binding, the approval status read, the
 * --project pin) asks here, so the old name, the new name and the token's
 * claim are one project on this machine, with the current name as the answer.
 * On 2026-11-06 the login lookup keyed by the token's old claim on one path and
 * by the platform's current slug on another, and an approved store submit
 * under the new name was refused as another project's (ledger 459).
 */
export function resolveProjectIdentity(api: string | undefined, named: string): ProjectIdentity | null {
  const wanted = String(named ?? "").trim();
  if (!wanted) return null;

  const stored = readCredentials({ project: wanted, api });
  if (!stored?.workspaceSlug || !stored.projectSlug) return null;

  const projectId = String(stored.projectId ?? "").trim();

  return {
    current: `${stored.workspaceSlug}/${stored.projectSlug}`.toLowerCase(),
    projectId: projectId.startsWith("prj_") ? projectId : "",
    movedFrom: stored.movedFrom ?? null,
  };
}

export function tokenProjectIdentity(api: string | undefined, token: string, claimed: string): ProjectIdentity | null {
  const held = String(token ?? "").trim();
  const store = held ? readCredentialStore() : null;
  const server = targetServer(api);
  const claim = String(claimed ?? "").trim().toLowerCase();
  const rows = store
    ? loginEntries(store)
        .map(([, row]) => row)
        .filter((row) => !row.movedTo && serverOf(row.api) === server && String(row.token ?? "").trim() === held)
    : [];
  const entry = rows.find((row) => `${row.workspaceSlug}/${row.projectSlug}`.toLowerCase() === claim) ?? (rows.length === 1 ? rows[0] : undefined);

  if (entry?.workspaceSlug && entry.projectSlug) {
    const projectId = String(entry.projectId ?? "").trim();
    const current = `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase();

    return {
      current,
      projectId: projectId.startsWith("prj_") ? projectId : "",
      movedFrom: claim && claim !== current ? claim : null,
    };
  }

  return resolveProjectIdentity(api, claimed);
}

export function currentProjectName(api: string | undefined, named: string): string {
  return resolveProjectIdentity(api, named)?.current ?? String(named ?? "").trim().toLowerCase();
}

export function sameStoredProject(api: string | undefined, a: string, b: string): boolean {
  const left = resolveProjectIdentity(api, a);
  const right = resolveProjectIdentity(api, b);
  if (!left || !right) return false;

  return left.current === right.current || (Boolean(left.projectId) && left.projectId === right.projectId);
}

export function movedNameNote(from: string, to: string): string {
  return `${from} is now ${to}; this call was made as ${to}, pass project: '${to}' from now on.`;
}
