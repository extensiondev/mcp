// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveCredential, type CredentialRef } from "./credential-source";
import { envelope, type ErrorCode } from "./envelope";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { noStoredLoginHint } from "./credentials";
import {
  platformHoldEnvelope,
  readPlatformCode,
  readPlatformMessage,
  sawPlatformHold,
} from "./platform-hold";
import { identityHeaders } from "./session-identity";
import { tokenRefusal } from "./token-refusal";

export { tokenRefusal } from "./token-refusal";

const READ_TIMEOUT_MS = 20_000;

export const OWNER_REQUIRED_CODE = "OWNER_REQUIRED";

export interface ProjectApi {
  base: string;
  token: string;
  projectId: string;
  ref: CredentialRef;
  command: string;
}

export interface ProjectApiRefusal {
  ok: false;
  status: number;
  code: string;
  message: string;
  held: boolean;
  body: unknown;
  retryAfterSeconds?: number;
}

export type ProjectApiRead<T> = { ok: true; json: T } | ProjectApiRefusal;

export type ProjectApiOpen =
  | { ok: true; api: ProjectApi }
  | {
      ok: false;
      reason: "no-login" | "other-project" | "bad-api" | "refused" | "unreachable" | "held";
      message: string;
      body?: unknown;
    };

const projectIds = new Map<string, string>();

function sameRef(a: CredentialRef, b: CredentialRef): boolean {
  return (
    a.workspace.toLowerCase() === b.workspace.toLowerCase() &&
    a.project.toLowerCase() === b.project.toLowerCase()
  );
}

async function getJson(
  url: string,
  token: string,
  command: string,
  send?: { method: string; body: unknown },
): Promise<{ res: Response | null; body: unknown; error?: string }> {
  let res: Response;

  try {
    res = await fetch(url, {
      ...(send ? { method: send.method, body: JSON.stringify(send.body) } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(send ? { "content-type": "application/json" } : {}),
        ...identityHeaders(command),
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err: any) {
    return { res: null, body: null, error: `could not reach ${url}: ${err?.message || err}` };
  }

  let body: unknown = null;

  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }

  return { res, body };
}

/* @invariant THE PROJECT ID COMES FROM THE SERVER THE TOKEN SPEAKS FOR. The
 * machine routes are keyed by prj_ id, which no stored login records, so it is
 * read from whoami on the same server with the same token: that is the one id
 * this token is already allowed to address, and an expected project that is not
 * the token's own is refused here instead of answering for the wrong project.
 */
export async function openProjectApi(args: {
  command: string;
  project?: string;
  api?: string;
  expect?: CredentialRef;
}): Promise<ProjectApiOpen> {
  const credential = resolveCredential({ project: args.project, api: args.api });

  if (!credential.token) {
    return {
      ok: false,
      reason: "no-login",
      message: args.project
        ? noStoredLoginHint(args.project)
        : "No login for this server. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN.",
    };
  }

  if (args.expect && (!credential.ref || !sameRef(credential.ref, args.expect))) {
    return {
      ok: false,
      reason: "other-project",
      message: `The login this call would use belongs to ${
        credential.ref ? `${credential.ref.workspace}/${credential.ref.project}` : "an unknown project"
      }, not ${args.expect.workspace}/${args.expect.project}, so the platform was not asked.`,
    };
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);
  if (!apiCheck.ok) return { ok: false, reason: "bad-api", message: apiCheck.message };

  const base = apiCheck.base.replace(/\/+$/, "");
  const cacheKey = `${base} ${credential.token}`;
  let projectId = projectIds.get(cacheKey) ?? "";

  if (!projectId) {
    const url = `${base}/api/cli/whoami`;
    const { res, body, error } = await getJson(url, credential.token, args.command);

    if (!res) return { ok: false, reason: "unreachable", message: error ?? `could not reach ${url}` };

    if (sawPlatformHold(res, body)) {
      return { ok: false, reason: "held", message: readPlatformMessage(body), body };
    }

    if (res.status === 401) {
      return {
        ok: false,
        reason: "refused",
        message: `${base} refused this login: it is expired, revoked, or minted on another server. Run extension_auth (action: login) again.`,
      };
    }

    projectId = String((body as { projectId?: unknown } | null)?.projectId ?? "").trim();

    if (!res.ok || !projectId.startsWith("prj_")) {
      return {
        ok: false,
        reason: "unreachable",
        message: `${url} answered ${res.status} without a project id, so the project's platform records cannot be addressed.`,
      };
    }

    projectIds.set(cacheKey, projectId);
  }

  return {
    ok: true,
    api: {
      base,
      token: credential.token,
      projectId,
      ref: credential.ref ?? { workspace: "", project: "" },
      command: args.command,
    },
  };
}

function retryAfterOf(res: Response, body: unknown): number | undefined {
  const said = Number((body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds);
  if (Number.isFinite(said) && said > 0) return Math.ceil(said);

  const header = Number(String(res.headers?.get?.("retry-after") ?? "").trim());

  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : undefined;
}

export async function platformApiGet<T = unknown>(
  api: Pick<ProjectApi, "base" | "token" | "command">,
  path: string,
  query?: Record<string, string | number | undefined>,
  send?: { method: "POST" | "PUT"; body: unknown },
): Promise<ProjectApiRead<T>> {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }

  const qs = search.toString();
  const url = `${api.base}${path}${qs ? `?${qs}` : ""}`;
  const { res, body, error } = await getJson(url, api.token, api.command, send);

  if (!res) {
    return { ok: false, status: 0, code: "", message: error ?? `could not reach ${url}`, held: false, body: null };
  }

  if (res.ok && body !== null) return { ok: true, json: body as T };

  const held = sawPlatformHold(res, body);
  const message = readPlatformMessage(body);
  const retryAfterSeconds = retryAfterOf(res, body);

  return {
    ok: false,
    status: res.status,
    code: readPlatformCode(body),
    message: `${url.split("?")[0]} answered ${res.status}${message ? `: ${message}` : res.ok ? " without a JSON body" : ""}`,
    held,
    body,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

export async function projectApiGet<T = unknown>(
  api: ProjectApi,
  route: string,
  query?: Record<string, string | number | undefined>,
): Promise<ProjectApiRead<T>> {
  return platformApiGet<T>(api, `/api/projects/${encodeURIComponent(api.projectId)}/${route}`, query);
}

export async function projectApiSend<T = unknown>(
  api: ProjectApi,
  method: "POST" | "PUT",
  route: string,
  body: unknown,
): Promise<ProjectApiRead<T>> {
  return platformApiGet<T>(api, `/api/projects/${encodeURIComponent(api.projectId)}/${route}`, undefined, { method, body });
}

export function projectApiOpenFailure(
  command: string,
  open: Extract<ProjectApiOpen, { ok: false }>,
  options: { api?: string; name: string; value?: Record<string, unknown> },
): string {
  if (open.reason === "held") {
    return platformHoldEnvelope({
      command,
      name: `${options.name}Held`,
      body: open.body,
      api: options.api,
      value: options.value,
    });
  }

  const auth = open.reason === "no-login" || open.reason === "refused" || open.reason === "other-project";
  const code: ErrorCode = auth ? "E_AUTH_REQUIRED" : open.reason === "bad-api" ? "E_BAD_HOST_URL" : "E_NETWORK";

  return envelope({
    ok: false,
    command,
    status: auth ? "auth-required" : "unavailable",
    value: options.value ?? {},
    error: { code, name: `${options.name}AuthError`, message: open.message },
  });
}

export function projectApiReadFailure(
  command: string,
  read: ProjectApiRefusal,
  options: {
    api?: string;
    name: string;
    value?: Record<string, unknown>;
    notFound?: string;
    context?: { workspace?: string; project?: string };
  },
): string {
  if (read.held) {
    return platformHoldEnvelope({
      command,
      name: `${options.name}Held`,
      body: read.body,
      api: options.api,
      value: options.value,
    });
  }

  const known = tokenRefusal(read.code, options.context);

  if (known) {
    return envelope({
      ok: false,
      command,
      status: known.status,
      value: options.value ?? {},
      error: {
        code: known.code,
        name: known.name,
        platformCode: read.code,
        message: read.message,
      },
      hint: known.hint,
    });
  }

  const ownerOnly = read.code === OWNER_REQUIRED_CODE;
  const auth = read.status === 401 || (read.status === 403 && !ownerOnly);
  const notFound = read.status === 404;
  const code: ErrorCode = auth
    ? "E_AUTH_DENIED"
    : ownerOnly
      ? "E_AUTH_DENIED"
      : notFound
        ? options.notFound === "build"
          ? "E_BUILD_NOT_FOUND"
          : "E_PLATFORM"
        : read.status === 0
          ? "E_NETWORK"
          : "E_PLATFORM";

  return envelope({
    ok: false,
    command,
    status: ownerOnly ? "needs-owner" : auth ? "refused" : notFound ? "not-found" : "unavailable",
    value: options.value ?? {},
    error: {
      code,
      name: `${options.name}${ownerOnly ? "OwnerRequired" : notFound ? "NotFound" : "Error"}`,
      ...(read.code ? { platformCode: read.code } : {}),
      message: ownerOnly
        ? `${read.message}. This read needs a token minted by a workspace owner.`
        : read.message,
    },
  });
}
