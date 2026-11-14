// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { serverOf } from "./credential-server";
import { bearerFetch } from "./platform-fetch";
import { PROJECT_HEADER } from "./request-fetch";

export const HOSTED_SWITCH = "EXTENSION_DEV_HOSTED";
export const FORWARD_URL_OVERRIDE = "EXTENSION_DEV_FORWARD_URL";
export const FORWARD_PATH = "/mcp/forward";
export const EXCHANGE_PATH = "/api/cli/forward/exchange";
export const LOCAL_FORWARD_URL = "http://localhost:3112/mcp/forward";
export const EXCHANGE_MARGIN_SECONDS = 60;
export const EXCHANGE_TIMEOUT_MS = 15_000;

export const FORWARD_PAIRS: Readonly<Record<string, string>> = Object.freeze({
  "https://www.extension.dev": "https://mcp.extension.dev/mcp/forward",
});

type Env = Record<string, string | undefined>;

export function hostedForwarding(env: Env = process.env): boolean {
  return String(env[HOSTED_SWITCH] ?? "").trim() === "1";
}

function loopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();

  return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
}

/* @invariant A STORED LOGIN IS FORWARDED ONLY TO THE HOSTED LANE PAIRED WITH
 * THE WWW THAT MINTED IT, FROM A CLOSED TABLE. Production www pairs with the
 * production lane and nothing else; a loopback www pairs with a loopback lane,
 * and only there may EXTENSION_DEV_FORWARD_URL move it, to another loopback
 * address. A project's .mcp.json sets environment variables, so no variable
 * can point a production login at an HTTPS host of a cloned repository's
 * choosing; any other www has no lane at all.
 */
export function forwardUrlFor(api: string, env: Env = process.env): string | null {
  const paired = FORWARD_PAIRS[serverOf(api)];
  if (paired) return paired;

  let parsed: URL;

  try {
    parsed = new URL(api);
  } catch {
    return null;
  }

  if (!loopback(parsed)) return null;

  const override = String(env[FORWARD_URL_OVERRIDE] ?? "").trim();
  if (!override) return LOCAL_FORWARD_URL;

  try {
    const target = new URL(override);

    return loopback(target) && target.pathname === FORWARD_PATH && !target.search && !target.username && !target.password ? `${target.origin}${FORWARD_PATH}` : null;
  } catch {
    return null;
  }
}

export interface ForwardCredential {
  token: string;
  expiresAt: number;
}

export type ExchangedCredential =
  | { ok: true; credential: ForwardCredential; cached: boolean }
  | { ok: false; status: number; code: string; message: string };

export interface ExchangeInput {
  api: string;
  login: string;
  project: string | null;
  resource: string;
  fresh?: boolean;
  fetchImpl?: typeof fetch;
}

const exchanged = new Map<string, ForwardCredential>();

function cacheKey(input: Pick<ExchangeInput, "api" | "login" | "resource">): string {
  return crypto.createHash("sha256").update(`${serverOf(input.api)}\n${input.resource}\n${input.login}`).digest("hex");
}

export function forgetForwardCredential(input: Pick<ExchangeInput, "api" | "login" | "resource">): void {
  exchanged.delete(cacheKey(input));
}

export function forgetForwardCredentials(): void {
  exchanged.clear();
}

function expiryOf(body: Record<string, unknown>, now: number): number {
  if (typeof body.expires_in === "number" && body.expires_in > 0) return now + Math.floor(body.expires_in);

  const at = Date.parse(String(body.expiresAt ?? ""));

  return Number.isFinite(at) ? Math.floor(at / 1000) : now;
}

/* @invariant THE DEVICE LOGIN GOES ONLY TO ITS OWN WWW, AND WHAT COMES BACK
 * LIVES IN MEMORY. The exchange is a POST to the www the login was minted on,
 * with the login as a bearer that never follows a redirect; the short
 * forward credential it answers is kept in this process, keyed by a hash of
 * the login, and used until a minute before it expires. Neither is written
 * to disk, to a log or into an answer, and a refused exchange keeps nothing.
 */
export async function forwardCredential(input: ExchangeInput): Promise<ExchangedCredential> {
  const key = cacheKey(input);
  const now = Math.floor(Date.now() / 1000);
  const held = exchanged.get(key);

  if (held && !input.fresh && held.expiresAt - EXCHANGE_MARGIN_SECONDS > now) return { ok: true, credential: held, cached: true };

  exchanged.delete(key);

  let res: Response;

  try {
    res = await bearerFetch(
      `${input.api.replace(/\/+$/, "")}${EXCHANGE_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.login}`,
          accept: "application/json",
          "content-type": "application/json",
          ...(input.project ? { [PROJECT_HEADER]: input.project } : {}),
        },
        body: JSON.stringify({ resource: input.resource }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      },
      input.fetchImpl,
    );
  } catch (err) {
    return { ok: false, status: 0, code: "UNREACHABLE", message: err instanceof Error ? err.message : String(err) };
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.access_token === "string" ? body.access_token.trim() : "";

  if (res.status !== 200 || !body || !token) {
    return { ok: false, status: res.status, code: String(body?.code ?? ""), message: String(body?.message ?? "") };
  }

  const credential = { token, expiresAt: expiryOf(body, now) };
  exchanged.set(key, credential);

  return { ok: true, credential, cached: false };
}
