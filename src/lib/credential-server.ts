// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROD_ORIGINS } from "@extension.dev/urls/origins";

function normalize(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(trimmed);

    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export const DEFAULT_SERVER = normalize(PROD_ORIGINS.www);

export function serverOf(api?: string | null): string {
  const raw = String(api ?? "").trim();

  return raw ? normalize(raw) : DEFAULT_SERVER;
}

export function targetServer(api?: string | null): string {
  return serverOf(String(api ?? "").trim() || process.env.EXTENSION_DEV_API_URL);
}

export function loginKey(workspaceSlug: string, projectSlug: string, api?: string | null): string {
  const ref = `${workspaceSlug}/${projectSlug}`.toLowerCase();
  const server = serverOf(api);

  return server === DEFAULT_SERVER ? ref : `${server} ${ref}`;
}
