// Platform publish client.
//
// This is the canonical implementation of the extension.dev publish flow,
// extracted from @extension.dev/mcp so every surface (MCP tool, extension.dev
// CLI, CI) shares one client. Auth is auth-AWARE not auth-HOLDING: the token
// is read at call time and never persisted or logged here. resolveToken()
// prefers EXTENSION_DEV_TOKEN from the environment, then falls back to the
// credentials file written by the login flow (see login-flow.ts). The publish
// flow itself never writes that file.

import { readValidCredentials } from "./credentials";
import { resolveApiBase, safeApiBase } from "./login-flow";

type FetchImpl = typeof fetch;

/** Resolve the access token: EXTENSION_DEV_TOKEN env first, then the login creds file. */
export function resolveToken(): string {
  const fromEnv = String(process.env.EXTENSION_DEV_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const creds = readValidCredentials();
  return creds?.token ? String(creds.token).trim() : "";
}

export interface PublishOptions {
  /** Share-link lifetime in hours (1-168, platform default 24). */
  ttlHours?: number;
  /** Pin the share URL to a specific build sha. */
  buildSha?: string;
  /** Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL). */
  api?: string;
  /** Explicit token; defaults to resolveToken(). */
  token?: string;
  fetchImpl?: FetchImpl;
}

export type PublishResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { name: string; message: string } };

/**
 * Publish the project the token is scoped to and return the platform
 * response (shareUrl, visibility, ...). The publish target is identified by
 * the token's claims (workspaceSlug/projectSlug), so no project path is sent.
 */
export async function publish(
  options: PublishOptions = {},
): Promise<PublishResult> {
  const token = options.token ?? resolveToken();
  if (!token) {
    return {
      ok: false,
      error: {
        name: "PublishAuthError",
        message:
          "No token. Run login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
      },
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  // Guard the token egress: the base URL is operator-supplied and the bearer
  // token must never leave over plaintext or to an arbitrary scheme.
  const apiCheck = safeApiBase(resolveApiBase(options.api));
  if (!apiCheck.ok) {
    return {
      ok: false,
      error: { name: "PublishConfigError", message: apiCheck.message },
    };
  }
  const url = `${apiCheck.base}/api/cli/publish`;

  const body: Record<string, unknown> = {};
  if (options.ttlHours != null) body.ttlHours = Number(options.ttlHours);
  if (options.buildSha) body.buildSha = options.buildSha;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return {
      ok: false,
      error: {
        name: "PublishNetworkError",
        message: `Could not reach ${url}: ${err?.message || err}`,
      },
    };
  }

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: {
        name: "PublishError",
        message: `publish failed (${res.status}): ${
          data?.message || text || "unknown error"
        }`,
      },
    };
  }

  return { ok: true, data };
}
