// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant
  * "CREATED" IS WHAT THE PLATFORM NAMED, NEVER WHAT THIS CALL ASKED FOR. An
  * empty 200, a proxy's HTML page and `{}` all read as created, and in a list
  * the echoed name then passed the check that is meant to compare the
  * platform's answer with the request. The answer now has to carry its own
  * proof: the success flag, an id, and the names the platform registered.
  * Anything short of that is unconfirmed, because a create cannot be retried
  * safely: the first one may have landed. The same third state covers a
  * request that left and got no usable answer (a dropped connection, a
  * gateway timeout): the outcome is unknown, so it is never called failed and
  * never retried blind.
  */
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

/* @invariant A server error with no platform code is an answer from in front
 * of the platform (a gateway timeout, a bad gateway), sent while the create
 * may still be running behind it. The platform's own failures carry a code
 * and say what they rolled back; this one says nothing, so it is unknown. */
export function answerIsUnknownOutcome(status: number, body: unknown): boolean {
  if (status < 500) return false;

  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;

  return !text(record?.code);
}
