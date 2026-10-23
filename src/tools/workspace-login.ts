// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { consoleWorkspacePath } from "@extension.dev/urls/paths";

import { consoleBase } from "../lib/console-urls";
import { listCredentials } from "../lib/credentials";
import { targetServer } from "../lib/credential-server";
import { envelope } from "../lib/envelope";
import { text } from "../lib/ship-act";

const COMMAND = "extension_workspace";

type Row = Record<string, unknown>;

export interface LoginArgs {
  action?: string;
  workspace?: string;
  project?: string;
  api?: string;
}

export function workspaceConsole(workspace: string, apiHint?: string): Row {
  const base = `${consoleBase(apiHint)}${consoleWorkspacePath(workspace)}`;

  return {
    workspace: base,
    plan: `${base}/settings/plan`,
    usage: `${base}/settings/usage`,
    members: `${base}/settings/members`,
  };
}

export function consoleOnly(workspace: string, apiHint?: string): string {
  const links = workspaceConsole(workspace || "<workspace>", apiHint);

  return `Plan and billing changes happen at ${links.plan}, and members are managed at ${links.members}; a project login never changes them.`;
}

export function storedLoginsOn(api?: string): Array<{ workspace: string; project: string; active: boolean; expiresAt: number }> {
  const server = targetServer(api);
  const now = Math.floor(Date.now() / 1000);

  return listCredentials()
    .filter((creds) => creds.server === server && creds.workspaceSlug && creds.projectSlug)
    .filter((creds) => !creds.expiresAt || creds.expiresAt > now)
    .map((creds) => ({
      workspace: creds.workspaceSlug.toLowerCase(),
      project: creds.projectSlug.toLowerCase(),
      active: creds.active,
      expiresAt: creds.expiresAt,
    }));
}

/* @invariant A WORKSPACE IS READ WITH A LOGIN OF THAT WORKSPACE, PICKED HERE.
 * There is no workspace token: the platform takes any project login of the
 * workspace and answers for the member who approved it. So a named workspace
 * is served by a stored login of that workspace on the server the call
 * targets, the default login first when it qualifies, never by a login of
 * another workspace sent to be refused. A login the caller names is sent as
 * named, and the platform's refusal is what answers a mismatch.
 */
export function pickLogin(args: LoginArgs): { project?: string } | { refused: string } {
  const named = text(args.project);
  if (named) return { project: named };

  const workspace = text(args.workspace).toLowerCase();
  if (!workspace) return {};

  const logins = storedLoginsOn(args.api);
  const own = logins
    .filter((login) => login.workspace === workspace)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.expiresAt - a.expiresAt);
  const chosen = own[0];

  if (chosen) return { project: `${chosen.workspace}/${chosen.project}` };

  const others = [...new Set(logins.map((login) => login.workspace))];

  return {
    refused: envelope({
      ok: false,
      command: COMMAND,
      status: "auth-required",
      value: { action: text(args.action) || "info", workspace },
      error: {
        code: "E_AUTH_REQUIRED",
        name: "WorkspaceLoginMissing",
        message: `No login on ${targetServer(args.api)} belongs to workspace ${workspace}, so the platform was not asked. Sign in to one of its projects with extension_auth (action: "login", project: "${workspace}/<project>"), or to all of them with extension_auth (action: "login", workspace: "${workspace}", projects: "*").`,
      },
      hint: others.length
        ? `Logins on this server cover ${others.join(", ")}.`
        : "This machine holds no login for this server yet.",
    }),
  };
}
