// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createdOnServer } from "../lib/created-projects";
import { credentialStoreProblem, defaultLoginDrift, isProjectRef, listCredentials, readCredentials } from "../lib/credentials";
import { resolveCredential } from "../lib/credential-source";
import { loginForPath, pathIdentity } from "../lib/path-project";
import {
  projectPresenceWith,
  sameSlugElsewhereWith,
  type PresenceLocal,
  type ProjectPresence,
} from "../lib/project-on-server";

import type { AuthLocal } from "./whoami";

export const AUTH_LOCAL: AuthLocal = {
  readCredentials,
  credentialStoreProblem,
  listCredentials,
  defaultLoginDrift,
  resolveCredential,
};

export function projectAtPath(projectPath: string, api?: string): { project: string; via: string } | null {
  const found = loginForPath(projectPath, api);
  if (found.state === "match") return { project: found.project, via: `its ${found.via}, a stored login` };

  const { owner, repo } = pathIdentity(projectPath);
  const project = `${owner}/${repo}`;

  return owner && repo && isProjectRef(project) ? { project, via: "its GitHub origin" } : null;
}

export const PRESENCE_LOCAL: PresenceLocal = {
  storedLogins: () => {
    try {
      return listCredentials();
    } catch {
      return [];
    }
  },
  createdOnServer,
};

export function projectPresence(apiBase: string, project: string, fetchImpl: typeof fetch = fetch): Promise<ProjectPresence> {
  return projectPresenceWith(PRESENCE_LOCAL, apiBase, project, fetchImpl);
}

export function sameSlugElsewhere(apiBase: string, project: string): string[] {
  return sameSlugElsewhereWith(PRESENCE_LOCAL, apiBase, project);
}
