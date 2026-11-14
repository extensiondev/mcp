// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createHash } from "node:crypto";

import { envToken } from "./credential-scope";
import { claimsCover, readTokenClaims } from "./credential-source";
import { readValidCredentials } from "./credentials";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { bearerHeaders } from "./request-fetch";
import { identityHeaders } from "./session-identity";
import { withoutRedirects } from "./platform-fetch";

import type { ProjectRef } from "./registry";

const REFRESH_LEAD_SECONDS = 60;

export type AccessGrant =
  | { status: "ok"; token: string; expiresAt: number }
  | { status: "public" }
  | { status: "no-credential" }
  | { status: "denied"; httpStatus?: number; message: string; reason?: string };

type CacheEntry =
  | { kind: "fresh"; token: string; expiresAt: number }
  | { kind: "pending"; promise: Promise<AccessGrant> };

interface GrantCredential {
  token: string;
  api?: string;
}

const CACHE_LIMIT = 512;

function credentialFor(ref: ProjectRef, apiHint?: string): GrantCredential | null {
  const creds = readValidCredentials(undefined, {
    project: `${ref.workspace}/${ref.project}`,
    api: apiHint,
  });
  const sameAs = (workspace: string, project: string): boolean =>
    workspace.toLowerCase() === ref.workspace.toLowerCase() &&
    project.toLowerCase() === ref.project.toLowerCase();
  let token = String(creds?.token || "").trim();

  if (token && creds?.workspaceSlug && creds?.projectSlug && !sameAs(creds.workspaceSlug, creds.projectSlug)) {
    token = "";
  }

  if (!token) {
    const env = envToken();

    if (env) {
      const claims = readTokenClaims(env);
      if (!claims || claimsCover(claims, ref)) token = env;
    }
  }

  return token ? { token, ...(creds?.api ? { api: creds.api } : {}) } : null;
}

/* @invariant A REGISTRY ACCESS TOKEN IS SERVED BACK ONLY TO THE CREDENTIAL
 * THAT MINTED IT. One process serves many callers on the hosted server, so
 * the cache key carries a hash of the bearer and the platform it was sent
 * to beside the project; a caller with no credential for the project never
 * reads the cache at all (ledger 664).
 */
function cacheKey(ref: ProjectRef, credential: GrantCredential, apiHint?: string): string {
  const holder = createHash("sha256").update(credential.token).digest("hex");

  return `${holder}\n${resolveApiBase(apiHint || credential.api)}\n${ref.workspace.toLowerCase()}/${ref.project.toLowerCase()}`;
}

export interface AccessTokenCacheOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export class RegistryAccessTokens {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl?: typeof fetch;
  private readonly nowSeconds: () => number;

  constructor(options?: AccessTokenCacheOptions) {
    this.fetchImpl = options?.fetchImpl;
    this.nowSeconds =
      options?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  peek(ref: ProjectRef, apiHint?: string): string {
    const credential = credentialFor(ref, apiHint);

    return credential ? this.fresh(cacheKey(ref, credential, apiHint))?.token ?? "" : "";
  }

  async get(ref: ProjectRef, apiHint?: string): Promise<AccessGrant> {
    const credential = credentialFor(ref, apiHint);
    if (!credential) return { status: "no-credential" };

    const key = cacheKey(ref, credential, apiHint);
    const entry = this.cache.get(key);
    if (entry?.kind === "pending") return entry.promise;

    const cached = this.fresh(key);
    if (cached) return { status: "ok", token: cached.token, expiresAt: cached.expiresAt };

    const promise = this.mint(ref, credential, apiHint);
    this.cache.set(key, { kind: "pending", promise });
    const result = await promise;

    if (result.status === "ok") {
      this.cache.delete(key);
      this.cache.set(key, {
        kind: "fresh",
        token: result.token,
        expiresAt: result.expiresAt,
      });

      this.prune();
    } else {
      this.cache.delete(key);
    }

    return result;
  }

  private fresh(key: string): { token: string; expiresAt: number } | null {
    const entry = this.cache.get(key);
    if (!entry || entry.kind !== "fresh") return null;

    return entry.expiresAt - REFRESH_LEAD_SECONDS > this.nowSeconds() ? entry : null;
  }

  private prune(): void {
    for (const [key, entry] of this.cache) {
      if (entry.kind === "fresh" && entry.expiresAt - REFRESH_LEAD_SECONDS <= this.nowSeconds()) this.cache.delete(key);
    }

    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= CACHE_LIMIT) break;

      this.cache.delete(oldest);
    }
  }

  private async mint(ref: ProjectRef, credential: GrantCredential, apiHint?: string): Promise<AccessGrant> {
    const token = credential.token;

    const check = safeApiBase(resolveApiBase(apiHint || credential.api), apiHint);
    if (!check.ok) return { status: "denied", message: check.message };

    let res: Response;

    try {
      res = await withoutRedirects(this.fetchImpl ?? fetch)(`${check.base}/api/access-grant`, {
        method: "POST",
        headers: {
          ...bearerHeaders(token, ref),
          "content-type": "application/json",
          ...identityHeaders("extension_registry_access"),
        },
        body: JSON.stringify({
          workspaceSlug: ref.workspace,
          projectSlug: ref.project,
        }),
      });
    } catch (err: any) {
      return {
        status: "denied",
        message: `Could not reach the access-grant endpoint: ${err?.message || err}`,
      };
    }

    if (res.status === 400) {
      let visibility: string;

      try {
        visibility = String(((await res.clone().json()) as { visibility?: unknown })?.visibility ?? "");
      } catch {
        visibility = "";
      }

      if (visibility && visibility !== "private") return { status: "public" };

      return {
        status: "denied",
        httpStatus: 400,
        message: "access-grant answered 400 without saying the project is public",
      };
    }

    if (!res.ok) {
      let said: { message?: unknown; reason?: unknown; code?: unknown } = {};

      try {
        said = (await res.clone().json()) as typeof said;
      } catch {
        said = {};
      }

      const detail = [said.reason, said.code, said.message].filter((v) => typeof v === "string" && v).join(": ");

      return {
        status: "denied",
        httpStatus: res.status,
        message: `access-grant returned ${res.status}${detail ? ` (${detail})` : ""}`,
        ...(typeof said.reason === "string" ? { reason: said.reason } : {}),
      };
    }

    let data: { token?: unknown; expiresAt?: unknown };

    try {
      data = JSON.parse(await res.text());
    } catch {
      return { status: "denied", message: "access-grant did not return JSON" };
    }

    const minted = String(data?.token || "").trim();

    if (!minted) {
      return { status: "denied", message: "access-grant returned no token" };
    }

    return {
      status: "ok",
      token: minted,
      expiresAt: Number(data?.expiresAt || 0),
    };
  }
}

export const defaultRegistryAccessTokens = new RegistryAccessTokens();

export function withAccessToken(url: string, token: string): string {
  if (!token) return url;

  try {
    const u = new URL(url);
    u.searchParams.set("t", token);

    return u.toString();
  } catch {
    return url;
  }
}
