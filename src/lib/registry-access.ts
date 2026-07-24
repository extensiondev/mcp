// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

// Short-lived registry access tokens for PRIVATE projects.
//
// The public registry answers 200 for public projects with no auth at all, so
// the read tools were built assuming that is the only case. For a private
// project every read 401s, which the release tools reported as "no builds" for
// a project the operator is logged into and owns. This module closes that gap
// the same way the userland SPA does (see its services/access-token-cache.ts):
// trade a credential for a 10-minute token and attach it as `?t=`.
//
// Why a trade instead of sending the stored token directly: the token the login
// flow persists and the token the registry Worker accepts are the SAME HMAC
// primitive, so the stored one WOULD work as `?t=`. It must not be used that
// way. It is long-lived (days) and a `?t=` value travels in a URL, which means
// every proxy and access log on the path keeps a copy. The trade narrows a
// multi-day credential to a ten-minute one before it goes on the wire.

import { readCredentials } from "./credentials";
import { resolveApiBase, safeApiBase } from "./login-flow";

import type { ProjectRef } from "./registry";

/** Attached slightly early so a token cannot expire mid-request. */
const REFRESH_LEAD_SECONDS = 60;

export type AccessGrant =
  | { status: "ok"; token: string; expiresAt: number }
  /** Project is public; no token is needed and none was minted. */
  | { status: "public" }
  /** No stored credential, or it does not cover the requested project. */
  | { status: "no-credential" }
  /** Reached the platform and it refused (401/403/5xx, network, bad body). */
  | { status: "denied"; httpStatus?: number; message: string };

type CacheEntry =
  | { kind: "fresh"; token: string; expiresAt: number }
  | { kind: "pending"; promise: Promise<AccessGrant> };

function cacheKey(ref: ProjectRef): string {
  return `${ref.workspace.toLowerCase()}/${ref.project.toLowerCase()}`;
}

export interface AccessTokenCacheOptions {
  fetchImpl?: typeof fetch;
  /** Test-only clock override, unix epoch seconds. */
  nowSeconds?: () => number;
}

/**
 * Per-process cache of minted tokens. Concurrent readers of the same project
 * share one in-flight mint: a single tool call fans out over meta.json,
 * channels.json and builds/index.json, and three cold 401s must not become
 * three mint round-trips.
 */
export class RegistryAccessTokens {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;

  constructor(options?: AccessTokenCacheOptions) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.nowSeconds =
      options?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** A cached, still-valid token, or "" if none. Never mints. */
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
      // Do not cache failures: a project can be made private, or the operator
      // can log in, between two calls in the same process.
      this.cache.delete(key);
    }
    return result;
  }

  private async mint(ref: ProjectRef, apiHint?: string): Promise<AccessGrant> {
    const creds = readCredentials();
    const token = String(
      process.env.EXTENSION_DEV_TOKEN || creds?.token || "",
    ).trim();
    if (!token) return { status: "no-credential" };

    // The platform refuses to mint for a project the bearer is not scoped to,
    // so asking for someone else's project is a guaranteed 403. Skip the call
    // when the stored login already tells us it will not match. A token from
    // EXTENSION_DEV_TOKEN has no local claims to check, so it still asks.
    if (creds?.workspaceSlug && creds?.projectSlug && !process.env.EXTENSION_DEV_TOKEN) {
      const same =
        creds.workspaceSlug.toLowerCase() === ref.workspace.toLowerCase() &&
        creds.projectSlug.toLowerCase() === ref.project.toLowerCase();
      if (!same) return { status: "no-credential" };
    }

    const check = safeApiBase(resolveApiBase(apiHint || creds?.api));
    if (!check.ok) return { status: "denied", message: check.message };

    let res: Response;
    try {
      res = await this.fetchImpl(`${check.base}/api/access-grant`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
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

    // 400 is the platform saying the project is public. That is not a failure:
    // the caller's unauthenticated read will succeed on its own.
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

/** Process-wide default, so one tool call's fan-out shares one mint. */
export const defaultRegistryAccessTokens = new RegistryAccessTokens();

/** Append `?t=<token>` to a registry URL. */
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
