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
  project: string | null;
}

const PROJECT_IDS: Record<string, string> = { "acme/web": "prj_hosted1", "acme/docs": "prj_hosted2" };

function whoami(authorization: string | null, named: string | null): unknown {
  if (!String(authorization ?? "").startsWith("Bearer oauth-")) {
    return { login: "acme/web", live: true, projectId: "prj_hosted1", workspaceSlug: "acme", projectSlug: "web" };
  }

  const projects = Object.entries(PROJECT_IDS).map(([ref, projectId]) => ({ projectId, workspaceSlug: "acme", projectSlug: ref.split("/")[1] }));
  const selected = named ? PROJECT_IDS[named] : undefined;

  return {
    live: true,
    tokenKind: "oauth",
    workspaceSlug: "acme",
    resource: "https://mcp.extension.dev/mcp",
    projects,
    ...(selected ? { login: named, projectId: selected, projectSlug: named!.split("/")[1] } : {}),
  };
}

export const APPROVAL = { approvalId: "apr_hosted", approvalUrl: "https://console.extension.dev/acme/web/approvals/apr_hosted" };

const PROJECT_ROWS = [
  { slug: "web", id: "prj_hosted1", displayName: "Web", lastBuild: { status: "failed", jobs: [{ browser: "chrome", conclusion: "failure" }] } },
  { slug: "docs", id: "prj_hosted2", displayName: "Docs", lastBuild: { status: "success", jobs: [] } },
];

function answer(url: URL, authorization: string | null, named: string | null, method = "GET"): { status: number; body: unknown } {
  if (url.pathname === "/api/cli/whoami") return { status: 200, body: whoami(authorization, named) };
  if (url.pathname === "/api/cli/approvals" && method === "POST") return { status: 200, body: { ...APPROVAL, expiresAt: "2099-01-01T00:00:00.000Z" } };
  if (url.pathname === "/api/projects") return { status: 200, body: { projects: PROJECT_ROWS, total: PROJECT_ROWS.length } };

  if (url.pathname === "/api/artifacts") return { status: 200, body: { artifacts: [] } };
  if (url.hostname.startsWith("registry.")) return { status: 404, body: { error: "not found" } };

  return { status: 200, body: { builds: [], items: [], projects: [], workspace: { slug: "acme" } } };
}

export function stubPlatformFetch(): SeenRequest[] {
  const seen: SeenRequest[] = [];

  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const request = {
      method: String(init?.method ?? "GET").toUpperCase(),
      url: url.toString(),
      authorization: headers.get("authorization"),
      project: headers.get("x-extensiondev-project"),
    };

    seen.push(request);
    const { status, body } = answer(url, request.authorization, request.project, request.method);

    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });

  return seen;
}
