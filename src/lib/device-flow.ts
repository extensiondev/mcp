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

export async function requestDeviceCode(args: {
  apiBase: string;
  path: string;
  project: string;
  clientName?: string;
  fetchImpl?: FetchImpl;
}): Promise<DeviceCodeStart> {
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(`${args.apiBase}${args.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      project: args.project,
      clientName: args.clientName ?? "extension-mcp",
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
    throw new Error(
      `Device code request failed (${res.status}): ${data.message || "unknown error"}`,
    );
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
      data.verification_uri || "https://extension.dev/device",
    ),
    verificationUriComplete: String(
      data.verification_uri_complete || data.verification_uri || "",
    ),
    interval: Number(data.interval || 5),
    expiresIn: Number(data.expires_in || 900),
  };
}

export type DevicePollResult =
  | { ok: true; creds: StoredCredentials }
  | { ok: false; reason: "pending" | "denied" | "expired" | "error"; message?: string };

export async function pollDeviceToken(args: {
  apiBase: string;
  path: string;
  project: string;
  deviceCode: string;
  interval: number;
  budgetMs: number;
  fetchImpl?: FetchImpl;
}): Promise<DevicePollResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const deadline = Date.now() + args.budgetMs;
  let interval = Math.max(1, args.interval);

  for (;;) {
    const res = await doFetch(`${args.apiBase}${args.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        device_code: args.deviceCode,
        project: args.project,
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
      try {
        const creds = persistTokenResponse({
          apiBase: args.apiBase,
          project: args.project,
          data,
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

    const error = String(data.error || "");
    if (error === "access_denied") {
      return { ok: false, reason: "denied" };
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
      };
    } else if (!error && !res.ok) {
      return {
        ok: false,
        reason: "error",
        message: `Device token poll failed (${res.status}): ${String(
          data.message || text || "no response body",
        ).slice(0, 200)}`,
      };
    }

    if (Date.now() + interval * 1000 >= deadline) {
      return { ok: false, reason: "pending" };
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}
