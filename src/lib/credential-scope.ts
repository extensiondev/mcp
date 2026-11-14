// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

export interface ScopedProject {
  workspace: string;
  project: string;
}

export interface RequestCredential {
  token: string;
  api: string;
  projects: ScopedProject[];
  expiresAt: number | null;
  project?: string | null;
  kind?: "oauth" | "forward";
  onUnauthorized?: () => void;
}

const scope = new AsyncLocalStorage<RequestCredential>();

function slug(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeRequestCredential(credential: RequestCredential): RequestCredential {
  const seen = new Set<string>();
  const projects: ScopedProject[] = [];

  for (const entry of credential.projects ?? []) {
    const workspace = slug(entry?.workspace);
    const project = slug(entry?.project);
    const key = `${workspace}/${project}`;
    if (!workspace || !project || seen.has(key)) continue;

    seen.add(key);
    projects.push({ workspace, project });
  }

  const expiresAt = Number(credential.expiresAt);
  const selected = coveredProject(projects, credential.project) ?? projects[0] ?? null;

  return {
    token: String(credential.token ?? "").trim(),
    api: String(credential.api ?? "").trim().replace(/\/+$/, ""),
    projects,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
    project: selected ? `${selected.workspace}/${selected.project}` : null,
    ...(credential.kind === "forward" ? { kind: "forward" as const } : {}),
    ...(credential.onUnauthorized ? { onUnauthorized: credential.onUnauthorized } : {}),
  };
}

export function coveredProject(projects: ScopedProject[], named: unknown): ScopedProject | null {
  const wanted = slug(named);
  if (!wanted) return null;

  const [first = "", second, ...rest] = wanted.split("/");
  if (rest.length) return null;

  const matches = projects.filter((entry) =>
    second === undefined ? entry.project === first : entry.workspace === first && entry.project === second,
  );

  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/* @invariant THE PROJECT A HOSTED CALL NAMES IS READ WHOLE BEFORE IT IS
 * COVERED. A tool builds its ref from `workspace` and `project` together, so
 * covering the slug alone let a caller who covers w1/b send workspace w2
 * beside it and have the registry read w2/b while the platform half read
 * w1/b. The two are joined the way the tool joins them: a bare slug beside a
 * workspace is that workspace's project, a full ref must agree with the
 * workspace beside it, and a workspace with no project must be one the
 * credential covers. The answer is the ref that is not covered, or null.
 */
export function uncoveredRef(args: { workspace?: unknown; project?: unknown }, projects: readonly ScopedProject[]): string | null {
  const project = slug(typeof args.project === "string" ? args.project : "");
  const workspace = slug(typeof args.workspace === "string" ? args.workspace : "");

  if (!project) return workspace && !projects.some((entry) => entry.workspace === workspace) ? workspace : null;

  const [first = "", second, ...rest] = project.split("/");

  if (rest.length || !first || (second !== undefined && (!second || (workspace && workspace !== first)))) {
    return workspace && second === undefined ? `${workspace}/${project}` : project;
  }

  const wanted = second === undefined ? { workspace: workspace || null, project: first } : { workspace: first, project: second };
  const matches = projects.filter((entry) => entry.project === wanted.project && (wanted.workspace === null || entry.workspace === wanted.workspace));

  return matches.length === 1 ? null : wanted.workspace ? `${wanted.workspace}/${wanted.project}` : wanted.project;
}

export function withRequestCredential<T>(credential: RequestCredential, run: () => T): T {
  return scope.run(normalizeRequestCredential(credential), run);
}

export function requestCredential(): RequestCredential | null {
  return scope.getStore() ?? null;
}

export function envToken(): string {
  return requestCredential() ? "" : String(process.env.EXTENSION_DEV_TOKEN || "").trim();
}

export function coveredProjects(): string[] {
  return (requestCredential()?.projects ?? []).map((entry) => `${entry.workspace}/${entry.project}`);
}

export const REQUEST_STORE_REFUSAL =
  "This server takes its credential from the connection's OAuth token and keeps no login store, so nothing was stored or removed. Sign in again from the MCP client to change which projects the connection covers.";
