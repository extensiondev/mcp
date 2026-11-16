// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { requestCredential } from "./credential-scope";
import { persistTokenResponse } from "./login-flow";
import { bearerFetch } from "./platform-fetch";
import { dropTrailing } from "./linear-text";

import type { StoredCredentials } from "./credentials";

type FetchImpl = typeof fetch;

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export type DeviceIntent = "login" | "create" | "create-workspace";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/* @invariant A DEVICE START MADE FOR A CALLER NAMES THAT CALLER. The hosted
 * server starts and polls approvals for every connected app from one
 * address, and the platform counts device starts per address when nobody is
 * named, so one caller could spend the start for all of them. Inside a
 * request credential's scope the start and its polls carry that caller's
 * own bearer, to the credential's own platform only and never through a
 * redirect, and the platform counts them under that caller. The local
 * server has no request credential, sends none, and is counted by the
 * person's own address as before.
 */
export function deviceCallerHeaders(apiBase: string): Record<string, string> {
  const caller = requestCredential();
  const origin = originOf(apiBase);

  return caller?.token && origin && origin === originOf(caller.api) ? { authorization: `Bearer ${caller.token}` } : {};
}

function deviceFetch(impl: FetchImpl): FetchImpl {
  return ((input: Parameters<FetchImpl>[0], init?: RequestInit) => bearerFetch(input, init, impl)) as FetchImpl;
}

export async function requestDeviceCode(args: {
  apiBase: string;
  path: string;
  project?: string;
  projects?: string[] | "*";
  workspace?: string;
  clientName?: string;
  intent?: DeviceIntent;
  fetchImpl?: FetchImpl;
}): Promise<DeviceCodeStart> {
  const doFetch = deviceFetch(args.fetchImpl ?? fetch);
  const batch =
    args.projects === "*" || (Array.isArray(args.projects) && args.projects.length > 0);
  const res = await doFetch(`${args.apiBase}${args.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...deviceCallerHeaders(args.apiBase) },
    body: JSON.stringify({
      ...(batch ? { projects: args.projects } : {}),
      ...(!batch && args.project ? { project: args.project } : {}),
      ...(args.workspace ? { workspace: args.workspace } : {}),
      clientName: args.clientName ?? "extension-mcp",
      ...(args.intent ? { intent: args.intent } : {}),
    }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;

  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const error = new Error(
      `Device code request failed (${res.status}): ${data.message || "unknown error"}`,
    ) as Error & {
      serverMessage?: string;
      serverCode?: string;
      httpStatus?: number;
    };

    if (typeof data.message === "string" && data.message.trim()) {
      error.serverMessage = data.message.trim();
    }

    if (typeof data.code === "string" && data.code.trim()) {
      error.serverCode = data.code.trim();
    }

    error.httpStatus = res.status;

    throw error;
  }

  const deviceCode = String(data.device_code || "").trim();
  const userCode = String(data.user_code || "").trim();

  if (!deviceCode || !userCode) {
    throw new Error("Device code response missing device_code/user_code.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri: String(
      data.verification_uri || `${dropTrailing(String(args.apiBase ?? "https://www.extension.dev"), "/")}/device`,
    ),
    verificationUriComplete: String(
      data.verification_uri_complete || data.verification_uri || "",
    ),
    interval: positiveNumber(data.interval, 5),
    expiresIn: positiveNumber(data.expires_in, 900),
  };
}

export type DevicePollResult =
  | { ok: true; creds: StoredCredentials }
  | {
      ok: false;
      reason: "pending" | "denied" | "expired" | "error";
      message?: string;
      code?: string;
      body?: Record<string, unknown>;
    };

export type DeviceGrantPollResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      reason: "pending" | "denied" | "expired" | "error";
      message?: string;
      code?: string;
      body?: Record<string, unknown>;
    };

export async function pollDeviceGrant(args: {
  apiBase: string;
  path: string;
  project?: string;
  projects?: string[] | "*";
  workspace?: string;
  deviceCode: string;
  interval: number;
  budgetMs: number;
  fetchImpl?: FetchImpl;
}): Promise<DeviceGrantPollResult> {
  const doFetch = deviceFetch(args.fetchImpl ?? fetch);
  const deadline = Date.now() + args.budgetMs;
  let interval = Math.max(1, args.interval);
  const batch =
    args.projects === "*" || (Array.isArray(args.projects) && args.projects.length > 0);

  for (;;) {
    const res = await doFetch(`${args.apiBase}${args.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...deviceCallerHeaders(args.apiBase) },
      body: JSON.stringify({
        device_code: args.deviceCode,
        ...(batch ? { projects: args.projects } : {}),
        ...(!batch && args.project ? { project: args.project } : {}),
        ...(args.workspace ? { workspace: args.workspace } : {}),
      }),
    });
    const text = await res.text();
    let data: Record<string, unknown>;

    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (res.ok && data.token) {
      return { ok: true, data };
    }

    const error = String(data.error || "");

    if (res.ok && !error) {
      return {
        ok: false,
        reason: "error",
        message: `The device token endpoint answered ${res.status} without a token and without an OAuth error${
          text ? ` (${text.slice(0, 200)})` : ""
        }; the approval may have been consumed by an answer this client cannot read.`,
      };
    }

    const code = String(data.code || "").trim();
    const refusal = code ? { code, body: data } : {};

    if (error === "access_denied") {
      return {
        ok: false,
        reason: "denied",
        ...(data.message ? { message: String(data.message) } : {}),
        ...refusal,
      };
    }

    if (error === "expired_token") {
      const said = String(data.error_description || data.message || "").trim();

      return { ok: false, reason: "expired", ...(said ? { message: said } : {}) };
    }

    if (error === "slow_down") {
      interval += 5;
    } else if (error && error !== "authorization_pending") {
      return {
        ok: false,
        reason: "error",
        message: String(data.message || error),
        ...refusal,
      };
    } else if (!error && !res.ok) {
      const retryAfter = String(res.headers?.get?.("retry-after") ?? "").trim();

      return {
        ok: false,
        reason: "error",
        message: `Device token poll failed (${res.status}): ${String(
          data.message || text || "no response body",
        ).slice(0, 200)}${res.status === 429 ? ` The platform rate-limited this poll${retryAfter ? ` and asks for ${retryAfter} seconds before the next one` : ""}; the device code is still pending.` : ""}`,
        ...refusal,
      };
    }

    if (Date.now() + interval * 1000 >= deadline) {
      return { ok: false, reason: "pending" };
    }

    const waitMs = interval * 1000;

    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export async function pollDeviceToken(args: {
  apiBase: string;
  path: string;
  project: string;
  deviceCode: string;
  interval: number;
  budgetMs: number;
  fetchImpl?: FetchImpl;
}): Promise<DevicePollResult> {
  const polled = await pollDeviceGrant(args);
  if (!polled.ok) return polled;

  try {
    const creds = persistTokenResponse({
      apiBase: args.apiBase,
      project: args.project,
      data: polled.data,
    });

    return { ok: true, creds };
  } catch (err: any) {
    return {
      ok: false,
      reason: "error",
      message: err?.message ? String(err.message) : String(err),
    };
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);

  return Number.isFinite(n) && n > 0 ? n : fallback;
}
