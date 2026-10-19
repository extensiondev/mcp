// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { serverOf } from "./credential-server";
import { listCredentials } from "./credentials";
import { platformApiGet } from "./project-api";

export interface ProjectFoundByRead {
  workspaceSlug: string;
  projectSlug: string;
  projectId: string | null;
  readWith: string;
}

const MAX_LOGINS_ASKED = 2;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function loginsOfWorkspace(apiBase: string, workspace: string, project: string) {
  const server = serverOf(apiBase);
  const now = Math.floor(Date.now() / 1000);

  return listCredentials()
    .filter((entry) => entry.server === server && entry.token)
    .filter((entry) => entry.workspaceSlug.toLowerCase() === workspace)
    .filter((entry) => !entry.expiresAt || entry.expiresAt > now)
    .sort((a, b) => Number(b.projectSlug.toLowerCase() === project) - Number(a.projectSlug.toLowerCase() === project))
    .slice(0, MAX_LOGINS_ASKED);
}

export async function findProjectByStoredLogin(args: {
  apiBase: string;
  project: string;
  command: string;
}): Promise<ProjectFoundByRead | null> {
  const [workspace = "", project = ""] = args.project.toLowerCase().split("/");
  if (!workspace || !project) return null;

  const base = args.apiBase.replace(/\/+$/, "");

  for (const login of loginsOfWorkspace(base, workspace, project)) {
    const api = { base, token: login.token, command: args.command };
    const readWith = `${login.workspaceSlug}/${login.projectSlug}`.toLowerCase();

    if (login.projectSlug.toLowerCase() === project) {
      const who = await platformApiGet<Record<string, unknown>>(api, "/api/cli/whoami");

      if (who.ok && text(who.json.login).toLowerCase() === args.project.toLowerCase()) {
        const projectId = text(who.json.projectId);

        return { workspaceSlug: workspace, projectSlug: project, projectId: projectId || null, readWith };
      }

      continue;
    }

    const listed = await platformApiGet<Record<string, unknown>>(api, "/api/projects", { workspace });
    if (!listed.ok) continue;

    const rows = Array.isArray(listed.json.projects) ? listed.json.projects : [];
    const match = rows.find(
      (row) => row && typeof row === "object" && text((row as Record<string, unknown>).slug).toLowerCase() === project,
    ) as Record<string, unknown> | undefined;

    if (match) {
      const projectId = text(match.id);

      return { workspaceSlug: workspace, projectSlug: project, projectId: projectId || null, readWith };
    }

    return null;
  }

  return null;
}
