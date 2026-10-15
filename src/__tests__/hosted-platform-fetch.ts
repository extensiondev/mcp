// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { vi } from "vitest";

export const WWW = "https://www.extension.dev";
export const PROJECT = { workspace: "acme", project: "web" };

export interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
}

function answer(url: URL): { status: number; body: unknown } {
  if (url.pathname === "/api/cli/whoami") {
    return { status: 200, body: { login: "acme/web", live: true, projectId: "prj_hosted1", workspaceSlug: "acme", projectSlug: "web" } };
  }

  if (url.pathname === "/api/artifacts") return { status: 200, body: { artifacts: [] } };
  if (url.hostname.startsWith("registry.")) return { status: 404, body: { error: "not found" } };

  return { status: 200, body: { builds: [], items: [], projects: [], workspace: { slug: "acme" } } };
}

export function stubPlatformFetch(): SeenRequest[] {
  const seen: SeenRequest[] = [];

  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.push({
      method: String(init?.method ?? "GET").toUpperCase(),
      url: url.toString(),
      authorization: new Headers(init?.headers).get("authorization"),
    });

    const { status, body } = answer(url);

    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });

  return seen;
}
