// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { moveCreatedProject } from "./created-projects";
import { PROJECT_PIN_ENV, pinnedProject, sameProject } from "./credentials";
import { isEnvelope } from "./envelope";

export const PROJECT_MOVED_STATUS = "moved";

export interface ProjectMove {
  from: string;
  to: string;
  projectId: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

export function readProjectMove(body: unknown, named?: string): ProjectMove | null {
  const row = (body ?? {}) as Record<string, unknown>;
  const workspace = text(row.workspaceSlug);
  const project = text(row.projectSlug);
  if (!workspace || !project) return null;

  const wanted = text(named);
  const previous = text(row.previousProjectSlug);
  const from = wanted.includes("/") ? wanted : previous ? `${workspace}/${previous}` : "";
  const to = `${workspace}/${project}`;
  if (!from || from === to) return null;

  const projectId = typeof row.projectId === "string" ? row.projectId.trim() : "";

  return { from, to, projectId: projectId.startsWith("prj_") ? projectId : "" };
}

export function movedAnswer(result: string): ProjectMove | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }

  if (!isEnvelope(parsed) || parsed.ok || parsed.status !== PROJECT_MOVED_STATUS) return null;

  const value = parsed.value && typeof parsed.value === "object" ? (parsed.value as { moved?: unknown }) : {};
  const moved = (value.moved ?? null) as Partial<ProjectMove> | null;
  if (!moved || typeof moved !== "object") return null;

  const from = text(moved.from);
  const to = text(moved.to);
  if (!from || !to || from === to) return null;

  return { from, to, projectId: typeof moved.projectId === "string" ? moved.projectId : "" };
}

export function followSentence(move: Pick<ProjectMove, "from" | "to">): string {
  return `${move.from} is now ${move.to}; this server follows the new name.`;
}

/* @invariant A MOVE THE PLATFORM ANSWERS IS FOLLOWED BY EVERY NAME THIS
 * SERVER KEPT FOR THE PROJECT, AND ONLY THOSE. The login store already moves
 * its entry when a rename is seen; the record of projects this server
 * created or onboarded and the --project pin kept the old slug, so a pinned
 * server refused the new name and the created record never matched again.
 * Both are rewritten here when they name the project that moved, and left
 * alone when they do not: a move answered for a project this server never
 * recorded or pinned writes nothing. The pin lives in the process env the
 * server set from --project, which is what the credential layer reads, so
 * the env is rewritten rather than the option alone.
 */
export function followProjectMove(args: { apiBase: string; move: ProjectMove }): string[] {
  const followed: string[] = [];

  if (moveCreatedProject(args.apiBase, args.move.from, args.move.to)) followed.push("created-projects");

  const pinned = pinnedProject();

  if (pinned && pinned.includes("/") && sameProject(args.move.from, pinned)) {
    process.env[PROJECT_PIN_ENV] = args.move.to;
    followed.push("pin");
  }

  return followed;
}
