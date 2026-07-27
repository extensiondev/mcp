// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readValidCredentials } from "./credentials";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { identityHeaders } from "./session-identity";

import type { ProjectRef } from "./registry";

const REFRESH_LEAD_SECONDS = 60;

export type AccessGrant =
  | { status: "ok"; token: string; expiresAt: number }
  | { status: "public" }
  | { status: "no-credential" }
  | { status: "denied"; httpStatus?: number; message: string };

type CacheEntry =
  | { kind: "fresh"; token: string; expiresAt: number }
  | { kind: "pending"; promise: Promise<AccessGrant> };

function cacheKey(ref: ProjectRef): string {
  return `${ref.workspace.toLowerCase()}/${ref.project.toLowerCase()}`;
}

export interface AccessTokenCacheOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export class RegistryAccessTokens {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;

  constructor(options?: AccessTokenCacheOptions) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.nowSeconds =
      options?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  peek(ref: ProjectRef): string {
    const entry = this.cache.get(cacheKey(ref));
    if (!entry || entry.kind !== "fresh") return "";
    return entry.expiresAt - REFRESH_LEAD_SECONDS > this.nowSeconds()
      ? entry.token
      : "";
  }

  async get(ref: ProjectRef, apiHint?: string): Promise<AccessGrant> {
    const key = cacheKey(ref);
    const entry = this.cache.get(key);
    if (entry?.kind === "pending") return entry.promise;
    const cached = this.peek(ref);
    if (cached) {
      return {
        status: "ok",
        token: cached,
        expiresAt: (this.cache.get(key) as { expiresAt: number }).expiresAt,
      };
    }

    const promise = this.mint(ref, apiHint);
    this.cache.set(key, { kind: "pending", promise });
    const result = await promise;
    if (result.status === "ok") {
      this.cache.set(key, {
        kind: "fresh",
        token: result.token,
        expiresAt: result.expiresAt,
      });
    } else {
      this.cache.delete(key);
    }
    return result;
  }

  private async mint(ref: ProjectRef, apiHint?: string): Promise<AccessGrant> {
    const creds = readValidCredentials();
    const token = String(
      process.env.EXTENSION_DEV_TOKEN || creds?.token || "",
    ).trim();
    if (!token) return { status: "no-credential" };

    if (creds?.workspaceSlug && creds?.projectSlug && !process.env.EXTENSION_DEV_TOKEN) {
      const same =
        creds.workspaceSlug.toLowerCase() === ref.workspace.toLowerCase() &&
        creds.projectSlug.toLowerCase() === ref.project.toLowerCase();
      if (!same) return { status: "no-credential" };
    }

    const check = safeApiBase(resolveApiBase(apiHint || creds?.api), apiHint);
    if (!check.ok) return { status: "denied", message: check.message };

    let res: Response;
    try {
      res = await this.fetchImpl(`${check.base}/api/access-grant`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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

    if (res.status === 400) return { status: "public" };
    if (!res.ok) {
      return {
        status: "denied",
        httpStatus: res.status,
        message: `access-grant returned ${res.status}`,
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
