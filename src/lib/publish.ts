// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveCredential } from "./credential-source";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { identityHeaders } from "./session-identity";
import { platformHoldMessage, sawPlatformHold } from "./platform-hold";

type FetchImpl = typeof fetch;

/* @invariant A `project` named by the caller is the one thing that outranks
   EXTENSION_DEV_TOKEN: the variable is the CI route and names no project,
   while an explicit project is a statement about which stored login this
   call is for. With no project, the order stays
   environment first, then the active stored login. */
export function resolveToken(options: { project?: string } = {}): string {
  return resolveCredential(options).token;
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
  | {
      ok: false;
      error: { name: string; message: string; code?: string; status?: number };
      held?: boolean;
      body?: unknown;
    };

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
  const apiCheck = safeApiBase(resolveApiBase(options.api), options.api);

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
        ...identityHeaders("extension_publish"),
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
    if (sawPlatformHold(res, data)) {
      return {
        ok: false,
        held: true,
        body: data,
        error: {
          name: "PublishHeld",
          message: platformHoldMessage(data, options.api),
        },
      };
    }

    return {
      ok: false,
      error: {
        name: "PublishError",
        ...(typeof data?.code === "string" ? { code: data.code } : {}),
        status: res.status,
        message: `publish failed (${res.status}): ${
          data?.message || text || "unknown error"
        }`,
      },
    };
  }

  return { ok: true, data };
}
