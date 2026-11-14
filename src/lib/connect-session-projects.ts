// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { memoryShelf } from "./call-memory";

const KEPT = 200;

const isProject = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const remembered = (): Map<string, string> => memoryShelf("connect-sessions", isProject);

function idOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function rememberConnectSession(session: unknown, project: string): void {
  const id = idOf(session);
  if (!id || !project) return;

  const projects = remembered();
  projects.delete(id);
  projects.set(id, project.toLowerCase());

  while (projects.size > KEPT) {
    const oldest = projects.keys().next().value;
    if (oldest === undefined) break;

    projects.delete(oldest);
  }
}

export function connectSessionProject(session: unknown): string | null {
  return remembered().get(idOf(session)) ?? null;
}

export function forgetConnectSessions(): void {
  remembered().clear();
}
