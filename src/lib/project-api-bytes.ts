// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { platformFetch } from "./platform-fetch";
import { readPlatformCode, readPlatformMessage, sawPlatformHold } from "./platform-hold";
import { identityHeaders } from "./session-identity";

import type { ProjectApi, ProjectApiRefusal } from "./project-api";

export type ProjectApiBytes =
  | { ok: true; bytes: Buffer; headers: Headers }
  | ProjectApiRefusal;

function unreached(url: string, message: string): ProjectApiRefusal {
  return { ok: false, status: 0, code: "", message: message || `could not reach ${url}`, held: false, body: null };
}

/* @invariant A BUILD FILE LEAVES THE PLATFORM THROUGH www, UNDER THE LOGIN'S
 * OWN TOKEN, AND NEVER THROUGH THE REGISTRY ADDRESS THE RECORD NAMES. The
 * registry answers 401 to a project token (ledger 152), so the one route
 * that hands a member the bytes is the project's artifact relay on the
 * platform server the login speaks for. The token travels in the
 * Authorization header only, the same way every JSON read sends it, and the
 * answer is read as bytes with the relay's digest headers kept beside them.
 */
export async function projectApiBytes(
  api: ProjectApi,
  route: string,
  options: { maxBytes: number },
): Promise<ProjectApiBytes> {
  const url = `${api.base}/api/projects/${encodeURIComponent(api.projectId)}/${route}`;
  const sent = await platformFetch(
    url,
    {
      headers: {
        authorization: `Bearer ${api.token}`,
        accept: "application/zip, application/json",
        ...identityHeaders(api.command),
      },
    },
    { kind: "dispatch" },
  );

  if (!sent.ok) return unreached(url, sent.unreached.message);

  const res = sent.res;

  if (!res.ok) {
    let body: unknown = null;

    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }

    const message = readPlatformMessage(body);

    return {
      ok: false,
      status: res.status,
      code: readPlatformCode(body),
      message: `${url} answered ${res.status}${message ? `: ${message}` : ""}`,
      held: sawPlatformHold(res, body),
      body,
    };
  }

  const declared = Number(res.headers?.get?.("content-length") ?? 0);

  if (declared > options.maxBytes) {
    return unreached(url, `${url} is ${declared} bytes, over the ${options.maxBytes} this tool downloads.`);
  }

  let bytes: Buffer;

  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    return unreached(url, `Could not read ${url}: ${err?.message || err}`);
  }

  if (bytes.length > options.maxBytes) {
    return unreached(url, `${url} is ${bytes.length} bytes, over the ${options.maxBytes} this tool downloads.`);
  }

  return { ok: true, bytes, headers: res.headers };
}
