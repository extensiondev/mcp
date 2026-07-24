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
  provider: "extensiondev" | "github";
  clientId: string;
  scope: string;
  deviceCodeUrl: string;
  deviceTokenUrl: string;
  verificationUri: string;
}

export async function fetchLoginConfig(
  apiBase: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginConfig> {
  const override = String(
    process.env.EXTENSION_DEV_GITHUB_CLIENT_ID || "",
  ).trim();
  if (override) {
    return {
      provider: "github",
      clientId: override,
      scope: "read:user",
      deviceCodeUrl: "/api/cli/device/code",
      deviceTokenUrl: "/api/cli/device/token",
      verificationUri: "https://github.com/login/device",
    };
  }

  const res = await fetchImpl(`${apiBase}/api/cli/login/config`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Could not fetch login config from ${apiBase} (${res.status}).`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = data.provider === "extensiondev" ? "extensiondev" : "github";
  const clientId = String(data.githubClientId || "").trim();

  if (provider === "github" && !clientId) {
    throw new Error(
      "Login is not configured on the server (no GitHub client id). " +
        "Set EXTENSION_DEV_GITHUB_CLIENT_ID to override.",
    );
  }
  return {
    provider,
    clientId,
    scope: String(data.scope || "read:user"),
    deviceCodeUrl: String(data.deviceCodeUrl || "/api/cli/device/code"),
    deviceTokenUrl: String(data.deviceTokenUrl || "/api/cli/device/token"),
    verificationUri: String(
      data.verificationUri || "https://github.com/login/device",
    ),
  };
}

export function persistTokenResponse(args: {
  apiBase: string;
  data: Record<string, unknown>;
  provider: "extensiondev" | "github";
}): StoredCredentials {
  const token = String(args.data.token || "").trim();
  if (!token) throw new Error("Login returned no token.");
  const creds: StoredCredentials = {
    version: 1,
    token,
    workspaceSlug: String(args.data.workspaceSlug || ""),
    projectSlug: String(args.data.projectSlug || ""),
    expiresAt: Number(args.data.expiresAt || 0),
    api: args.apiBase,
    provider: args.provider,
  };
  writeCredentials(creds);
  return creds;
}

export async function exchangeAndPersist(args: {
  apiBase: string;
  githubToken: string;
  project: string;
  fetchImpl?: FetchImpl;
}): Promise<StoredCredentials> {
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(`${args.apiBase}/api/cli/login/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      githubToken: args.githubToken,
      project: args.project,
    }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    throw new Error(
      `Login exchange failed (${res.status}): ${
        data.message || "unknown error"
      }`,
    );
  }
  return persistTokenResponse({
    apiBase: args.apiBase,
    data,
    provider: "github",
  });
}
