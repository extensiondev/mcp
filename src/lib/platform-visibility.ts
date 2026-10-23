// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openProjectApi, projectApiGet } from "./project-api";

export type ProjectVisibility = "public" | "private";

export type PlatformVisibilityRead =
  | { ok: true; visibility: ProjectVisibility }
  | { ok: false; skipped: true }
  | { ok: false; skipped: false; held: boolean; body?: unknown; message: string };

export function asProjectVisibility(value: unknown): ProjectVisibility | null {
  const text = String(value ?? "").trim().toLowerCase();

  return text === "public" || text === "private" ? text : null;
}

export async function readPlatformVisibility(args: {
  ref: { workspace: string; project: string };
  named: boolean;
  api?: string;
}): Promise<PlatformVisibilityRead> {
  const opened = await openProjectApi({
    command: "extension_release_status",
    project: args.named ? `${args.ref.workspace}/${args.ref.project}` : undefined,
    api: args.api,
    expect: args.ref,
  });

  if (!opened.ok) {
    if (opened.reason === "no-login" || opened.reason === "other-project") return { ok: false, skipped: true };

    return { ok: false, skipped: false, held: opened.reason === "held", body: opened.body, message: opened.message };
  }

  const read = await projectApiGet<{ visibility?: unknown }>(opened.api, "visibility");

  if (!read.ok) return { ok: false, skipped: false, held: read.held, body: read.body, message: read.message };

  const visibility = asProjectVisibility(read.json.visibility);

  if (!visibility) {
    return { ok: false, skipped: false, held: false, message: "the platform answered the visibility read without a public or private value" };
  }

  return { ok: true, visibility };
}
