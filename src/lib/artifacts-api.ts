// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveToken } from "./publish";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { identityHeaders } from "./session-identity";
import { platformHoldMessage, sawPlatformHold } from "./platform-hold";

type FetchImpl = typeof fetch;

const ARTIFACT_ID = /^gen_(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const ARTIFACT_ID_CANDIDATE = /gen_[0-9a-f]+/;

export type ArtifactOwner =
  | { kind: "project"; workspace: string; project: string }
  | { kind: "user" };

export interface ArtifactPublisher {
  via: "token" | "session";
  login: string | null;
  workspace: string | null;
  project: string | null;
  tokenId: string | null;
}

export const ZIP_URL_REDIRECT_NOTE =
  "zipUrl does not serve the archive itself: it answers 302 with a short-lived presigned storage URL in Location. Follow redirects when you fetch it (curl -L; fetch and most HTTP clients already do), because a client that does not follow them reads 0 bytes and reports the share as empty when it is not.";

export interface ListedArtifact {
  artifactId: string;
  kind?: string;
  name?: string;
  slug?: string;
  version?: string;
  live: boolean;
  createdAt?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  sizeBytes?: number | null;
  previewUrl?: string | null;
  viewUrl?: string | null;
  zipUrl?: string | null;
  revokeUrl?: string;
  owner?: ArtifactOwner | null;
  sharedBy?: ArtifactPublisher | null;
}

export interface ArtifactListing {
  artifacts: ListedArtifact[];
  malformedRows?: number;
  count: number;
  matched: number;
  limit: number;
  truncated: boolean;
  truncatedReported: boolean;
  scanned: number;
}

export interface ArtifactRevocation {
  artifactId: string;
  revoked: boolean;
  revokedAt?: string;
}

export type ArtifactsOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { name: string; message: string; status?: number; code?: string };
      held?: boolean;
      body?: unknown;
    };

function heldOutcome(
  name: string,
  res: Response,
  data: unknown,
  api?: string,
): ArtifactsOutcome<never> {
  return {
    ok: false,
    held: true,
    body: data,
    error: { name, status: res.status, message: platformHoldMessage(data, api) },
  };
}

export function parseArtifactRef(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (ARTIFACT_ID.test(raw)) return raw;

  let parsed: URL | null;

  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const fromQuery = parsed.searchParams.get("preview");
    if (fromQuery && ARTIFACT_ID.test(fromQuery.trim())) return fromQuery.trim();

    const segments = parsed.pathname.split("/").filter(Boolean);

    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const rawSegment = segments[i];
      if (!rawSegment) continue;

      const segment = decodeURIComponent(rawSegment);
      if (ARTIFACT_ID.test(segment)) return segment;
    }
  }

  const loose = ARTIFACT_ID_CANDIDATE.exec(raw);

  return loose && ARTIFACT_ID.test(loose[0]) ? loose[0] : null;
}

export function wwwRevokeUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  if (parsed.hostname.toLowerCase() !== "extension.dev") return value;

  parsed.hostname = "www.extension.dev";

  return parsed.toString();
}

function authError(name: string): ArtifactsOutcome<never> {
  return {
    ok: false,
    error: {
      name,
      message:
        "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
    },
  };
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

export async function listArtifacts(options: {
  limit?: number;
  liveOnly?: boolean;
  api?: string;
  token?: string;
  fetchImpl?: FetchImpl;
} = {}): Promise<ArtifactsOutcome<ArtifactListing>> {
  const token = options.token ?? resolveToken({ api: options.api });
  if (!token) return authError("SharesAuthError");

  const apiCheck = safeApiBase(resolveApiBase(options.api), options.api);

  if (!apiCheck.ok) {
    return {
      ok: false,
      error: { name: "SharesConfigError", message: apiCheck.message },
    };
  }

  const url = new URL(`${apiCheck.base}/api/artifacts`);
  if (options.limit != null) url.searchParams.set("limit", String(options.limit));
  if (options.liveOnly) url.searchParams.set("status", "live");

  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;

  try {
    res = await doFetch(url.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...identityHeaders("extension_shares"),
      },
    });
  } catch (err: any) {
    return {
      ok: false,
      error: {
        name: "SharesNetworkError",
        message: `Could not reach ${url.toString()}: ${err?.message || err}`,
      },
    };
  }

  const data = await readBody(res);

  if (sawPlatformHold(res, data)) {
    return heldOutcome("SharesHeld", res, data, options.api);
  }

  if (res.status === 401) return authError("SharesAuthError");

  if (!res.ok) {
    return {
      ok: false,
      error: {
        name: "SharesListError",
        status: res.status,
        message: `Listing shares failed (${res.status}): ${
          (data?.message as string) || "unknown error"
        }`,
      },
    };
  }

  if (!Array.isArray(data.artifacts)) {
    return {
      ok: false,
      error: {
        name: "SharesListError",
        status: res.status,
        message: `Listing shares answered ${res.status} without an artifacts list, so which shares exist is unknown.`,
      },
    };
  }

  const rows = data.artifacts as ListedArtifact[];
  const valid = rows.filter((artifact) => artifact && typeof (artifact as { artifactId?: unknown }).artifactId === "string");
  const malformedRows = rows.length - valid.length;
  const artifacts = valid.map((artifact) =>
    typeof artifact.revokeUrl === "string"
      ? { ...artifact, revokeUrl: wwwRevokeUrl(artifact.revokeUrl) }
      : artifact,
  );
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return {
    ok: true,
    data: {
      artifacts,
      ...(malformedRows ? { malformedRows } : {}),
      count: num(data.count, artifacts.length),
      matched: num(data.matched, artifacts.length),
      limit: num(data.limit, artifacts.length),
      truncated: data.truncated === true,
      truncatedReported: typeof data.truncated === "boolean",
      scanned: num(data.scanned, 0),
    },
  };
}

export async function revokeArtifact(options: {
  artifactId: string;
  api?: string;
  token?: string;
  approvalId?: string;
  fetchImpl?: FetchImpl;
}): Promise<ArtifactsOutcome<ArtifactRevocation>> {
  const token = options.token ?? resolveToken({ api: options.api });
  if (!token) return authError("SharesAuthError");

  const apiCheck = safeApiBase(resolveApiBase(options.api), options.api);

  if (!apiCheck.ok) {
    return {
      ok: false,
      error: { name: "SharesConfigError", message: apiCheck.message },
    };
  }

  const url = `${apiCheck.base}/api/artifacts/${encodeURIComponent(
    options.artifactId,
  )}`;
  const approvalId = String(options.approvalId || "").trim();
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;

  try {
    res = await doFetch(url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(approvalId ? { "x-extensiondev-approval": approvalId } : {}),
        ...identityHeaders("extension_shares"),
      },
    });
  } catch (err: any) {
    return {
      ok: false,
      error: {
        name: "SharesNetworkError",
        message: `Could not reach ${url}: ${err?.message || err}`,
      },
    };
  }

  const data = await readBody(res);

  if (sawPlatformHold(res, data)) {
    return heldOutcome("SharesHeld", res, data, options.api);
  }

  if (res.status === 401) {
    return {
      ok: false,
      error: {
        name: "SharesAuthError",
        status: 401,
        ...(typeof data?.code === "string" ? { code: data.code } : {}),
        message: `The platform refused the token this revoke was sent with (${
          typeof data?.code === "string" ? data.code : "401"
        }): it is expired, revoked, or not a project token. Sign in again with extension_auth (action: login).`,
      },
    };
  }

  if (res.status === 404 && typeof data?.code === "string" && data.code !== "ARTIFACT_NOT_FOUND") {
    return {
      ok: false,
      error: {
        name: "SharesRevokeError",
        status: 404,
        code: data.code,
        message: `Revoking ${options.artifactId} was refused (${data.code}): ${
          (data?.message as string) || "no message"
        }. The share was not touched.`,
      },
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      error: {
        name: "SharesNotFoundError",
        status: 404,
        message: `The platform has no live share ${options.artifactId} for this token. It may already be revoked, already expired, owned by a different project than the one this token is scoped to, or a teammate's personal share, which belongs to that person alone and no project token can revoke.`,
      },
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: {
        name: "SharesRevokeError",
        status: res.status,
        ...(typeof data?.code === "string" ? { code: data.code } : {}),
        message: `Revoking ${options.artifactId} failed (${res.status}): ${
          (data?.message as string) || "unknown error"
        }`,
      },
    };
  }

  return {
    ok: true,
    data: {
      artifactId: options.artifactId,
      revoked: data.revoked === true,
      ...(typeof data.revokedAt === "string"
        ? { revokedAt: data.revokedAt }
        : {}),
    },
  };
}
