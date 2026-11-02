// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const KEPT = 200;

const projects = new Map<string, string>();

function idOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function rememberConnectSession(session: unknown, project: string): void {
  const id = idOf(session);
  if (!id || !project) return;

  projects.delete(id);
  projects.set(id, project.toLowerCase());

  while (projects.size > KEPT) {
    const oldest = projects.keys().next().value;
    if (oldest === undefined) break;

    projects.delete(oldest);
  }
}

export function connectSessionProject(session: unknown): string | null {
  return projects.get(idOf(session)) ?? null;
}

export function forgetConnectSessions(): void {
  projects.clear();
}
