// Self-contained publish (no CLI shell-out).
//
// This is the OWNED implementation of the extension.dev publish flow. The OSS
// `extension publish` CLI command is now only a thin wrapper kept for the
// terminal funnel; the canonical/maintained logic lives here. The small POST
// duplication between the two is intentional — the MCP must not depend on the
// OSS CLI for the one platform-gated tool.
//
// Auth is auth-AWARE not auth-HOLDING: the token is read at call time and never
// persisted or logged by the MCP. resolveToken() prefers EXTENSION_DEV_TOKEN
// from the environment, then falls back to the credentials file written by
// extension_login (see tools/login.ts). The publish flow itself never writes
// that file.

import { readValidCredentials } from "../lib/credentials";

const DEFAULT_API = "https://www.extension.dev";

export const schema = {
  name: "extension_publish",
  description:
    "Publish a project to extension.dev and return a shareable URL. Auth-gated: requires EXTENSION_DEV_TOKEN (a workspace/project access token) in the environment. Posts to the platform's CLI publish endpoint directly. This is the only tool that talks to the hosted platform rather than the local browser.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      ttlHours: {
        type: "number",
        description: "Share-link lifetime in hours (1–168, default 24)",
      },
      buildSha: {
        type: "string",
        description: "Pin the share URL to a specific build sha",
      },
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL)",
      },
    },
    required: ["projectPath"],
  },
};

/** Resolve the access token: EXTENSION_DEV_TOKEN env first, then the login creds file. */
export function resolveToken(): string {
  const fromEnv = String(process.env.EXTENSION_DEV_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const creds = readValidCredentials();
  return creds?.token ? String(creds.token).trim() : "";
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

function fail(name: string, message: string): string {
  return JSON.stringify({ ok: false, error: { name, message } });
}

export async function handler(args: {
  // projectPath is accepted for interface parity with the CLI; the publish
  // target is identified by the token's claims (workspaceSlug/projectSlug),
  // so the value is not sent in the request body.
  projectPath: string;
  ttlHours?: number;
  buildSha?: string;
  api?: string;
}): Promise<string> {
  const token = resolveToken();
  if (!token) {
    return fail(
      "PublishAuthError",
      "No token. Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
    );
  }

  const apiCheck = safeApiBase(
    String(args.api || process.env.EXTENSION_DEV_API_URL || DEFAULT_API),
  );
  if (!apiCheck.ok) {
    return fail("PublishConfigError", apiCheck.message);
  }
  const url = `${apiCheck.base}/api/cli/publish`;

  const body: Record<string, unknown> = {};
  if (args.ttlHours != null) body.ttlHours = Number(args.ttlHours);
  if (args.buildSha) body.buildSha = args.buildSha;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return fail("PublishNetworkError", `Could not reach ${url}: ${err?.message || err}`);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    return fail(
      "PublishError",
      `publish failed (${res.status}): ${data?.message || text || "unknown error"}`,
    );
  }

  // Success: return the platform response verbatim (shareUrl, visibility, …).
  return JSON.stringify(data);
}
