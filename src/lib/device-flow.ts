// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { persistTokenResponse } from "./login-flow";
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

/* @invariant A workspace create names a workspace and no project, so the
 * request carries `workspace` instead of `project`; every other intent keeps
 * the `project` field byte for byte. The platform refuses a create-workspace
 * request whose slug has a slash, so the two shapes cannot be confused.
 *
 * A batch carries `projects` and never `project` beside it: the platform
 * refuses a request that names its target both ways, because the approver is
 * shown one of them. So a list wins here and the single name is left out. */
export async function requestDeviceCode(args: {
  apiBase: string;
  path: string;
  project?: string;
  projects?: string[];
  workspace?: string;
  clientName?: string;
  intent?: DeviceIntent;
  fetchImpl?: FetchImpl;
}): Promise<DeviceCodeStart> {
  const doFetch = args.fetchImpl ?? fetch;
  const batch = Array.isArray(args.projects) && args.projects.length > 0;
  const res = await doFetch(`${args.apiBase}${args.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
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
      data.verification_uri || `${String(args.apiBase ?? "https://www.extension.dev").replace(/\/+$/, "")}/device`,
    ),
    verificationUriComplete: String(
      data.verification_uri_complete || data.verification_uri || "",
    ),
    /* @invariant A non-numeric interval or expiry is the default, never NaN:
       NaN defeated both the sleep and the deadline, so the poll ran hot with
       no end. */
    interval: positiveNumber(data.interval, 5),
    expiresIn: positiveNumber(data.expires_in, 900),
  };
}

export type DevicePollResult =
  | { ok: true; creds: StoredCredentials }
  | { ok: false; reason: "pending" | "denied" | "expired" | "error"; message?: string };

/* @invariant A refusal keeps the platform's own `code` and body beside the
 * reason. The reason is the four words every caller already branches on; the
 * code is what tells a lane that closed, a member who left or a list with a
 * missing project apart from a human pressing Deny, all of which the platform
 * answers under the same `access_denied` or with no RFC error word at all. A
 * caller reads the code, never the sentence. */
export type DeviceGrantPollResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      reason: "pending" | "denied" | "expired" | "error";
      message?: string;
      code?: string;
      body?: Record<string, unknown>;
    };

/* @invariant This poll returns the raw token response and PERSISTS NOTHING.
 * The provisioning lane rides it: a provisioning grant lives minutes, opens
 * exactly one endpoint, and writing it into the credentials file would
 * overwrite a real project login with a credential every other tool's door
 * refuses. Only pollDeviceToken, the login lane, may persist, and it does so
 * by delegating here and writing afterwards.
 */
export async function pollDeviceGrant(args: {
  apiBase: string;
  path: string;
  project?: string;
  projects?: string[];
  workspace?: string;
  deviceCode: string;
  interval: number;
  budgetMs: number;
  fetchImpl?: FetchImpl;
}): Promise<DeviceGrantPollResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const deadline = Date.now() + args.budgetMs;
  let interval = Math.max(1, args.interval);
  const batch = Array.isArray(args.projects) && args.projects.length > 0;

  for (;;) {
    const res = await doFetch(`${args.apiBase}${args.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
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
    /* @invariant A 2xx that carries neither a token nor an OAuth error is an
       answer this client does not understand, not "still pending": a batch
       code is spent when minting starts, so calling it pending lost the
       tokens and the next call said expired. */
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
      return { ok: false, reason: "expired" };
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
      return {
        ok: false,
        reason: "error",
        message: `Device token poll failed (${res.status}): ${String(
          data.message || text || "no response body",
        ).slice(0, 200)}`,
        ...refusal,
      };
    }

    if (Date.now() + interval * 1000 >= deadline) {
      return { ok: false, reason: "pending" };
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
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
