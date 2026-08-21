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

/* @invariant
 * The id shape below is the mint's, not this file's. www mints gen_ plus
 * crypto.randomBytes(32) as hex, 64 characters, and the only other width the
 * platform ever issued is the retired 32-character derived form. A width the
 * mint never produced is refused whole: the fallback extracts the maximal hex
 * run and accepts it only if the entire run is a minted width, because a
 * pattern that stops early turns a pasted 64-character id into its 32-character
 * prefix, and that truncated id then revokes nothing while reporting the wrong
 * causes. A ref that does not match is a named refusal, never a quiet
 * substring.
 */
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

/* @invariant Any zipUrl this package hands out travels with this sentence.
 *
 * The platform does not serve the archive from that address: it answers 302
 * and puts a short-lived presigned storage URL in Location, so a caller that
 * does not follow redirects reads an empty body and concludes the share is
 * empty when it is whole. This package's own read already follows the hops
 * (share-cors-probe walks them by hand), but the URL is also copied out to
 * humans and to agents that will curl it, and to them the 302 is invisible
 * until it costs them the download. Naming the redirect is the only part of
 * this that belongs here: the server's arm is www's to change, not ours. */
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
      error: { name: string; message: string; status?: number };
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
      const raw = segments[i];
      if (!raw) continue;
      const segment = decodeURIComponent(raw);
      if (ARTIFACT_ID.test(segment)) return segment;
    }
  }

  const loose = ARTIFACT_ID_CANDIDATE.exec(raw);
  return loose && ARTIFACT_ID.test(loose[0]) ? loose[0] : null;
}

/* @invariant
 * A revoke handle this package hands out must work with one plain DELETE.
 * The platform builds revokeUrl from its configured public origin, which in
 * production is the apex extension.dev, and the apex answers DELETE with a 307
 * to www.extension.dev. A caller who does not follow redirects gets
 * "Redirecting..." back and the share stays live, silently. Rewriting the apex
 * to the www host here makes the handle honest; any other host, including
 * localhost and self-hosted bases, passes through untouched.
 */
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
  const token = options.token ?? resolveToken();
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

  const artifacts = Array.isArray(data.artifacts)
    ? (data.artifacts as ListedArtifact[]).map((artifact) =>
        artifact && typeof artifact.revokeUrl === "string"
          ? { ...artifact, revokeUrl: wwwRevokeUrl(artifact.revokeUrl) }
          : artifact,
      )
    : [];
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return {
    ok: true,
    data: {
      artifacts,
      count: num(data.count, artifacts.length),
      matched: num(data.matched, artifacts.length),
      limit: num(data.limit, artifacts.length),
      truncated: data.truncated === true,
      /* @invariant
       * A listing that never mentions truncated is not a whole listing.
       *
       * `truncated === true` collapses a missing field into false, and false is
       * the reading that lets extension_shares call a local record "not owned
       * by this token", which a reader hears as "that link is dead". The field
       * going away in a server release would therefore turn every share the
       * page did not reach into a false accusation, silently and in
       * production. Reporting whether the server said anything at all keeps
       * absent distinguishable from whole.
       */
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
  const token = options.token ?? resolveToken();
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
  if (res.status === 401) return authError("SharesAuthError");
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
