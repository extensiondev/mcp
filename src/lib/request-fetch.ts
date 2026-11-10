// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { requestCredential } from "./credential-scope";
import { MEMBER_PROJECT } from "./credentials";

export const PROJECT_HEADER = "x-extensiondev-project";

type ProjectName = { workspace: string; project: string } | null | undefined;

/* @invariant A STORED LOGIN TRAVELS WITH THE PROJECT IT IS SENT FOR. A member
 * login names a person and a workspace, not a project, and every www door
 * authorizes it for the project named in the x-extensiondev-project header;
 * one minted for a single project is unchanged by the header. So every call
 * that knows which project it acts on names it beside the bearer, and a
 * member login never lands on a door with no project to be checked against.
 */
export function projectHeader(ref: ProjectName): Record<string, string> {
  const workspace = String(ref?.workspace ?? "").trim().toLowerCase();
  const project = String(ref?.project ?? "").trim().toLowerCase();
  if (!workspace || !project || project === MEMBER_PROJECT) return {};

  return { [PROJECT_HEADER]: `${workspace}/${project}` };
}

export function bearerHeaders(token: string, ref?: ProjectName): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...projectHeader(ref) };
}

const INSTALLED = Symbol.for("extension.dev/mcp request fetch");

type Fetch = typeof fetch;

function requestUrl(input: unknown): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

function originOf(api: string): string | null {
  try {
    return new URL(api).origin;
  } catch {
    return null;
  }
}

export function installRequestFetch(): void {
  const current = globalThis.fetch as Fetch & { [INSTALLED]?: true };
  if (typeof current !== "function" || current[INSTALLED]) return;

  const wrapped = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const scoped = requestCredential();
    const url = scoped?.project ? requestUrl(input) : null;

    if (!scoped?.project || !url || url.origin !== originOf(scoped.api)) return current(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers).entries()) headers.set(name, value);
    if (!headers.has(PROJECT_HEADER)) headers.set(PROJECT_HEADER, scoped.project);

    const res = await current(input, { ...init, headers });
    if (res.status === 401) scoped.onUnauthorized?.();

    return res;
  }) as Fetch & { [INSTALLED]?: true };

  wrapped[INSTALLED] = true;
  globalThis.fetch = wrapped;
}
