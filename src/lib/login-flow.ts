// Shared pieces of the `login` flow used by both the MCP tool (two-phase,
// returns promptly) and the human `extension-mcp login` bin (blocking). Keeps
// the config fetch and token exchange in one place so the two surfaces cannot
// drift.

import { writeCredentials, type StoredCredentials } from "./credentials";

const DEFAULT_API = "https://www.extension.dev";

type FetchImpl = typeof fetch;

export function resolveApiBase(api?: string): string {
  return String(
    api || process.env.EXTENSION_DEV_API_URL || DEFAULT_API,
  ).replace(/\/+$/, "");
}

/**
 * Validate the platform base URL BEFORE we attach a bearer token to a request to
 * it. SECURITY: the `api` arg / EXTENSION_DEV_API_URL is operator-supplied, but a
 * hostile value (e.g. via prompt-injection in the client) could redirect the
 * token to an attacker. The access token must never leave over plaintext or go to
 * an arbitrary scheme, so we require https -- allowing http only for localhost
 * dev. Returns the normalized base (no trailing slash) or an error message.
 */
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
  clientId: string;
  scope: string;
}

/**
 * Resolve the GitHub OAuth client id the device flow authenticates against.
 * EXTENSION_DEV_GITHUB_CLIENT_ID overrides (useful when pointing at a self-
 * hosted platform); otherwise it comes from the platform's public config.
 */
export async function fetchLoginConfig(
  apiBase: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginConfig> {
  const override = String(
    process.env.EXTENSION_DEV_GITHUB_CLIENT_ID || "",
  ).trim();
  if (override) return { clientId: override, scope: "read:user" };

  const res = await fetchImpl(`${apiBase}/api/cli/login/config`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Could not fetch login config from ${apiBase} (${res.status}).`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const clientId = String(data.githubClientId || "").trim();
  if (!clientId) {
    throw new Error(
      "Login is not configured on the server (no GitHub client id). " +
        "Set EXTENSION_DEV_GITHUB_CLIENT_ID to override.",
    );
  }
  return { clientId, scope: String(data.scope || "read:user") };
}

/**
 * Trade a verified GitHub user token for a project-scoped access token and
 * write it to the local credentials file. Returns the stored credentials
 * (token included for the caller's in-memory use; never logged).
 */
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
  const token = String(data.token || "").trim();
  if (!token) throw new Error("Login exchange returned no token.");

  const creds: StoredCredentials = {
    version: 1,
    token,
    workspaceSlug: String(data.workspaceSlug || ""),
    projectSlug: String(data.projectSlug || ""),
    expiresAt: Number(data.expiresAt || 0),
    api: args.apiBase,
  };
  writeCredentials(creds);
  return creds;
}
