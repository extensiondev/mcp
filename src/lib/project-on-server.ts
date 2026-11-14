// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { serverOf } from "./credential-server";

export type ProjectPresence = "public" | "not-public" | "unknown";

export interface PresenceLogin {
  server: string;
  workspaceSlug: string;
  projectSlug: string;
}

export interface PresenceLocal {
  storedLogins(): PresenceLogin[];
  createdOnServer(apiBase: string, project: string): boolean;
}

function storedHere(local: PresenceLocal, apiBase: string, project: string): boolean {
  const here = serverOf(apiBase);
  const wanted = project.toLowerCase();

  return local.storedLogins().some(
    (entry) => entry.server === here && `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase() === wanted,
  );
}

const PRESENCE_TIMEOUT_MS = 4_000;

export async function projectPresenceWith(
  local: PresenceLocal,
  apiBase: string,
  project: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectPresence> {
  if (storedHere(local, apiBase, project) || local.createdOnServer(apiBase, project)) return "public";

  const [workspace = "", projectSlug = ""] = project.split("/");
  const url = `${apiBase}/api/projects/resolve?workspace=${encodeURIComponent(workspace)}&projectSlug=${encodeURIComponent(projectSlug)}`;

  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS),
    });

    if (res.ok) return "public";
    if (res.status === 404) return "not-public";

    return "unknown";
  } catch {
    return "unknown";
  }
}

export function sameSlugElsewhereWith(local: PresenceLocal, apiBase: string, project: string): string[] {
  const here = serverOf(apiBase);
  const wanted = project.toLowerCase();

  return [
    ...new Set(
      local.storedLogins()
        .filter((entry) => entry.server !== here)
        .filter((entry) => `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase() === wanted)
        .map((entry) => entry.server),
    ),
  ];
}
