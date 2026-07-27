// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { writeCredentials, type StoredCredentials } from "./credentials";
import { PROD_ORIGINS } from "@extension.dev/urls/origins";
import { consoleBase, consoleProjectUrl } from "./registry";

const DEFAULT_API = PROD_ORIGINS.www;

export function tokenTtlNote(
  workspaceSlug?: string,
  projectSlug?: string,
): string {
  const tokensUrl =
    workspaceSlug && projectSlug
      ? consoleProjectUrl(
          { workspace: workspaceSlug, project: projectSlug },
          "settings/access-tokens",
        )
      : consoleBase();
  return `extension.dev CLI tokens live at most 7 days (server-enforced). CI pipelines must re-mint before expiry on the console's Access tokens page: ${tokensUrl}`;
}

type FetchImpl = typeof fetch;

export function resolveApiBase(api?: string): string {
  return String(
    api || process.env.EXTENSION_DEV_API_URL || DEFAULT_API,
  ).replace(/\/+$/, "");
}

export function safeApiBase(
  raw: string,
): { ok: true; base: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `Invalid platform URL: ${raw}` };
  }
  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    return {
      ok: false,
      message: `Refusing to send the access token to ${raw}: use https (http is allowed only for localhost).`,
    };
  }
  return { ok: true, base: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") };
}

export interface LoginConfig {
  deviceCodeUrl: string;
  deviceTokenUrl: string;
  verificationUri: string;
}

export async function fetchLoginConfig(
  apiBase: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginConfig> {
  const res = await fetchImpl(`${apiBase}/api/cli/login/config`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Could not fetch login config from ${apiBase} (${res.status}).`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    deviceCodeUrl: String(data.deviceCodeUrl || "/api/cli/device/code"),
    deviceTokenUrl: String(data.deviceTokenUrl || "/api/cli/device/token"),
    verificationUri: String(
      data.verificationUri || `${apiBase.replace(/\/+$/, "")}/device`,
    ),
  };
}

export function persistTokenResponse(args: {
  apiBase: string;
  project: string;
  data: Record<string, unknown>;
}): StoredCredentials {
  const token = String(args.data.token || "").trim();
  if (!token) throw new Error("Login returned no token.");
  const workspaceSlug = String(args.data.workspaceSlug || "").trim();
  const projectSlug = String(args.data.projectSlug || "").trim();
  if (!workspaceSlug || !projectSlug) {
    throw new Error(
      `Login for ${args.project} returned a token without a workspace/project scope; nothing was stored. Run extension_auth (action: login) again.`,
    );
  }
  const [wantWorkspace = "", wantProject = ""] = args.project.split("/");
  const matches =
    workspaceSlug.toLowerCase() === wantWorkspace.toLowerCase() &&
    projectSlug.toLowerCase() === wantProject.toLowerCase();
  if (!matches) {
    throw new Error(
      `Login returned a token scoped to ${workspaceSlug}/${projectSlug}, not the requested ${args.project}; nothing was stored. Run extension_auth (action: login) again with the intended project.`,
    );
  }
  const creds: StoredCredentials = {
    version: 1,
    token,
    workspaceSlug,
    projectSlug,
    expiresAt: Number(args.data.expiresAt || 0),
    api: args.apiBase,
    provider: "extensiondev",
  };
  writeCredentials(creds);
  return creds;
}
