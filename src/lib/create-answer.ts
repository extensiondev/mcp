// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type CreatedProject =
  | { ok: true; projectId: string; workspaceSlug: string; projectSlug: string }
  | { ok: false; why: string };

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function readCreatedProject(body: unknown): CreatedProject {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!record) return { ok: false, why: "the answer was not a JSON object" };

  if (record.success !== true) {
    return { ok: false, why: "the answer did not carry success: true" };
  }

  const projectId = text(record.projectId);
  const workspaceSlug = text(record.workspaceSlug);
  const projectSlug = text(record.projectSlug);
  if (!projectId) return { ok: false, why: "the answer named no project id" };

  if (!workspaceSlug || !projectSlug) {
    return {
      ok: false,
      why: "the answer did not name the workspace and project it registered",
    };
  }

  return { ok: true, projectId, workspaceSlug, projectSlug };
}

export type CreatedWorkspace =
  | { ok: true; id: string; slug: string }
  | { ok: false; why: string };

export function readCreatedWorkspace(body: unknown): CreatedWorkspace {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!record) return { ok: false, why: "the answer was not a JSON object" };

  const id = text(record.id);
  const slug = text(record.slug);
  if (!id) return { ok: false, why: "the answer named no workspace id" };
  if (!slug) return { ok: false, why: "the answer did not name the workspace it registered" };

  return { ok: true, id, slug };
}

export function answerIsUnknownOutcome(status: number, body: unknown): boolean {
  if (status < 500) return false;

  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;

  return !text(record?.code);
}
