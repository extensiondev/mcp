// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { requestCredential } from "./credential-scope";

export const PROJECT_HEADER = "x-extensiondev-project";

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
