// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readValidCredentials } from "./credentials";
import { resolveApiBase, safeApiBase } from "./login-flow";

type FetchImpl = typeof fetch;

export function resolveToken(): string {
  const fromEnv = String(process.env.EXTENSION_DEV_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const creds = readValidCredentials();
  return creds?.token ? String(creds.token).trim() : "";
}

export interface PublishOptions {
  ttlHours?: number;
  buildSha?: string;
  api?: string;
  token?: string;
  fetchImpl?: FetchImpl;
}

export type PublishResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { name: string; message: string } };

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
