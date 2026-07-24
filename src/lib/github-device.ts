// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export type PollResult =
  | { ok: true; githubToken: string }
  | { ok: false; reason: "pending" | "expired" | "denied"; error?: string };

type FetchImpl = typeof fetch;
type SleepImpl = (ms: number) => Promise<void>;

const defaultSleep: SleepImpl = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function startDeviceCode(args: {
  clientId: string;
  scope?: string;
  fetchImpl?: FetchImpl;
}): Promise<DeviceCodeStart> {
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      scope: args.scope || "read:user",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.error) {
    throw new Error(
      `GitHub device-code request failed: ${
        data.error_description || data.error || res.status
      }`,
    );
  }
  return {
    deviceCode: String(data.device_code || ""),
    userCode: String(data.user_code || ""),
    verificationUri: String(
      data.verification_uri || "https://github.com/login/device",
    ),
    interval: Number(data.interval || 5),
    expiresIn: Number(data.expires_in || 900),
  };
}

export async function pollForToken(args: {
  clientId: string;
  deviceCode: string;
  interval: number;
  budgetMs: number;
  fetchImpl?: FetchImpl;
  sleepImpl?: SleepImpl;
}): Promise<PollResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const sleep = args.sleepImpl ?? defaultSleep;
  let intervalMs = Math.max(1, args.interval) * 1000;
  const deadline = Date.now() + Math.max(0, args.budgetMs);

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await doFetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: args.clientId,
        device_code: args.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const token = String(data.access_token || "").trim();
    if (token) return { ok: true, githubToken: token };

    const error = String(data.error || "");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs = Math.max(
        intervalMs + 5000,
        Number(data.interval || 0) * 1000,
      );
      continue;
    }
    if (error === "expired_token") return { ok: false, reason: "expired" };
    if (error === "access_denied") return { ok: false, reason: "denied" };
  }
  return { ok: false, reason: "pending" };
}
