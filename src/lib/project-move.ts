// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PIN_ENV, moveLogin, pinnedProject, sameProject } from "./credentials";
import { isEnvelope } from "./envelope";
import { kernelHook } from "./kernel-hooks";

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
 * SERVER KEPT FOR THE PROJECT, AND ONLY THOSE. The stored login, the record
 * of projects this server created or onboarded and the --project pin each
 * keep the slug, so each is rewritten here when it names the project that
 * moved, and left alone when it does not: a move answered for a project
 * this server never signed in to, recorded or pinned writes nothing. The
 * login moves here because the platform read that used to see the rename
 * now runs on the hosted lane, which holds no login store: until 2026-11-15
 * a forwarded call that was told "moved" asked again under the new slug and
 * was answered that no login is stored for it. The pin lives in the process env the
 * server set from --project, which is what the credential layer reads, so
 * the env is rewritten rather than the option alone.
 */
export function followProjectMove(args: { apiBase: string; move: ProjectMove }): string[] {
  const followed: string[] = [];
  const [workspaceSlug = "", fromProjectSlug = ""] = args.move.from.split("/");
  const [, toProjectSlug = ""] = args.move.to.split("/");

  if (workspaceSlug && fromProjectSlug && toProjectSlug && moveLogin({ workspaceSlug, fromProjectSlug, toProjectSlug, api: args.apiBase, ...(args.move.projectId ? { projectId: args.move.projectId } : {}) })) followed.push("login");

  if (kernelHook("moveCreatedProject")(args.apiBase, args.move.from, args.move.to)) followed.push("created-projects");

  const pinned = pinnedProject();

  if (pinned && pinned.includes("/") && sameProject(args.move.from, pinned)) {
    process.env[PROJECT_PIN_ENV] = args.move.to;
    followed.push("pin");
  }

  return followed;
}
