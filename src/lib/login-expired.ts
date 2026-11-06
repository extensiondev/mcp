// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { approvalLogin } from "./approval-scope";
import { consoleProjectUrl } from "./console-urls";
import { envToken, requestCredential } from "./credential-scope";
import { readTokenClaims, splitRef } from "./credential-source";
import { expiredStoredLogin, type ExpiredLogin } from "./credentials";
import { requestDeviceCode } from "./device-flow";
import { codeExpiryFromStart, rememberCodeExpiry } from "./device-wait";
import { envelope } from "./envelope";
import { fetchLoginConfig, resolveApiBase, safeApiBase } from "./login-flow";

import type { NextStep } from "./store-connection";

export type { ExpiredLogin } from "./credentials";

export interface ProjectSlugs {
  workspace: string;
  project: string;
}

export interface RenewCall {
  tool: "extension_auth";
  args: { action: "login"; project: string; deviceCode?: string };
}

export interface DeviceRenewal {
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  then: RenewCall;
}

export const LOGIN_EXPIRED_STATUS = "not-signed-in";
export const LOGIN_EXPIRED_CODE = "E_AUTH_EXPIRED";

const RENEWAL_BOUND_MS = 8_000;
const RENEWAL_REUSE_MARGIN_MS = 30_000;
const renewals = new Map<string, DeviceRenewal>();

function sameSlugs(a: ProjectSlugs, b: ProjectSlugs): boolean {
  return a.workspace.toLowerCase() === b.workspace.toLowerCase() && a.project.toLowerCase() === b.project.toLowerCase();
}

function envTokenCovers(ref: ProjectSlugs): boolean {
  const env = envToken();
  if (!env) return false;

  const claims = readTokenClaims(env);

  return !claims || sameSlugs(claims, ref);
}

export function expiredLoginFor(ref: ProjectSlugs, api?: string, nowSeconds: number = Math.floor(Date.now() / 1000)): ExpiredLogin | null {
  if (approvalLogin() || envTokenCovers(ref)) return null;

  return expiredStoredLogin({ project: `${ref.workspace}/${ref.project}`, api }, nowSeconds);
}

export function renewCall(project: string, deviceCode?: string): RenewCall {
  return { tool: "extension_auth", args: { action: "login", project, ...(deviceCode ? { deviceCode } : {}) } };
}

function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(RENEWAL_BOUND_MS) });
}

export function forgetLoginRenewals(): void {
  renewals.clear();
}

export async function startLoginRenewal(expired: ExpiredLogin, api?: string): Promise<DeviceRenewal | null> {
  if (expired.hosted || requestCredential()) return null;

  const apiCheck = safeApiBase(resolveApiBase(api), api);
  if (!apiCheck.ok) return null;

  const key = `${apiCheck.base}|${expired.project}`;
  const kept = renewals.get(key);
  if (kept && Date.parse(kept.expiresAt) - Date.now() > RENEWAL_REUSE_MARGIN_MS) return kept;

  renewals.delete(key);

  try {
    const config = await fetchLoginConfig(apiCheck.base, boundedFetch);
    const start = await requestDeviceCode({ apiBase: apiCheck.base, path: config.deviceCodeUrl, project: expired.project, fetchImpl: boundedFetch });
    const expiresAt = codeExpiryFromStart(start.expiresIn);
    const complete = String(start.verificationUriComplete || "").trim();
    const renewal: DeviceRenewal = {
      verificationUrl: complete || start.verificationUri,
      userCode: start.userCode,
      expiresAt,
      then: renewCall(expired.project, start.deviceCode),
    };

    rememberCodeExpiry(start.deviceCode, expiresAt);
    renewals.set(key, renewal);

    return renewal;
  } catch {
    return null;
  }
}

function ago(seconds: number): string {
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min ago`;

  return `${Math.round(seconds / 86400)} days ago`;
}

export function loginCall(project: string): string {
  return `extension_auth {action: "login", project: "${project}"}`;
}

export function expiredLoginDetail(expired: ExpiredLogin): string {
  const sentence = `The stored login for ${expired.project} expired at ${expired.expiresAt} (${ago(expired.expiredForSeconds)}), so this server sent no token and the platform read the call as missing-token.`;

  return expired.hosted
    ? `${sentence} Sign in again from your MCP client.`
    : `${sentence} Run ${loginCall(expired.project)} to refresh it.`;
}

function renewSentence(expired: ExpiredLogin, device: DeviceRenewal | null): string {
  if (device) {
    const resume = `extension_auth {action: "login", project: "${expired.project}", deviceCode: "${device.then.args.deviceCode}"}`;

    return `Open ${device.verificationUrl} and approve (code ${device.userCode}, valid until ${device.expiresAt}), then call ${resume} to store the renewed login`;
  }

  return expired.hosted ? "Sign in again from your MCP client" : `Sign in again with ${loginCall(expired.project)}`;
}

export interface LoginExpiredRefusal {
  command: string;
  expired: ExpiredLogin;
  trackUrl: string;
  extra?: Record<string, unknown>;
  device?: DeviceRenewal | null;
  pageWord?: string;
}

export function loginExpiredRefusal(args: LoginExpiredRefusal): string {
  const { expired } = args;
  const device = args.device ?? null;
  const [workspace = "", project = ""] = expired.project.split("/");
  const step: NextStep = {
    kind: "login",
    say: `${renewSentence(expired, device)}, then call this again. The login for ${expired.project} expired at ${expired.expiresAt} (${ago(expired.expiredForSeconds)}).`,
    url: device?.verificationUrl ?? args.trackUrl,
  };

  return envelope({
    ok: false,
    command: args.command,
    status: LOGIN_EXPIRED_STATUS,
    value: {
      workspace,
      project,
      login: {
        project: expired.project,
        expiresAt: expired.expiresAt,
        expiredForSeconds: expired.expiredForSeconds,
        sent: false,
        renew: device?.then ?? renewCall(expired.project),
        ...(device ? { device } : {}),
      },
      nextStep: step,
      trackUrl: args.trackUrl,
      ...(args.extra ?? {}),
    },
    error: {
      code: LOGIN_EXPIRED_CODE,
      name: "LoginExpired",
      message: `The login for ${expired.project} expired at ${expired.expiresAt} (${ago(expired.expiredForSeconds)}), so nothing was read or sent: this server drops an expired token instead of sending it, and the platform would have read the call as missing-token.`,
    },
    hint: `${step.say} The ${args.pageWord ?? "store page"} is ${args.trackUrl}.`,
  });
}

export function expiredLoginPage(expired: ExpiredLogin, api?: string): string {
  return consoleProjectUrl(splitRef(expired.project), ConsoleProjectPage.overview, api);
}

export async function expiredLoginRefusal(
  args: Omit<LoginExpiredRefusal, "device" | "trackUrl" | "pageWord"> & { api?: string; trackUrl?: string; pageWord?: string },
): Promise<string> {
  const device = await startLoginRenewal(args.expired, args.api);
  const trackUrl = args.trackUrl ?? expiredLoginPage(args.expired, args.api);

  return loginExpiredRefusal({ ...args, trackUrl, pageWord: args.pageWord ?? (args.trackUrl ? "store page" : "project page"), device });
}
