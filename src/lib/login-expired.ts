// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { approvalLogin } from "./approval-scope";
import { envToken, requestCredential } from "./credential-scope";
import { readTokenClaims } from "./credential-source";
import { readCredentials } from "./credentials";
import { envelope } from "./envelope";

import type { NextStep } from "./store-connection";

export interface ProjectSlugs {
  workspace: string;
  project: string;
}

export interface ExpiredLogin {
  project: string;
  expiresAt: string;
  expiredForSeconds: number;
  hosted: boolean;
}

export const LOGIN_EXPIRED_STATUS = "not-signed-in";
export const LOGIN_EXPIRED_CODE = "E_AUTH_EXPIRED";

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

  const creds = readCredentials({ project: `${ref.workspace}/${ref.project}`, api });
  if (!creds?.expiresAt || creds.expiresAt > nowSeconds) return null;

  return {
    project: `${creds.workspaceSlug}/${creds.projectSlug}`.toLowerCase(),
    expiresAt: new Date(creds.expiresAt * 1000).toISOString(),
    expiredForSeconds: nowSeconds - creds.expiresAt,
    hosted: Boolean(requestCredential()),
  };
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

export function loginExpiredRefusal(args: { command: string; expired: ExpiredLogin; trackUrl: string; extra?: Record<string, unknown> }): string {
  const { expired } = args;
  const [workspace = "", project = ""] = expired.project.split("/");
  const signIn = expired.hosted ? "Sign in again from your MCP client" : `Sign in again with ${loginCall(expired.project)}`;
  const step: NextStep = {
    kind: "login",
    say: `${signIn}, then call this again. The login for ${expired.project} expired at ${expired.expiresAt} (${ago(expired.expiredForSeconds)}).`,
    url: args.trackUrl,
  };

  return envelope({
    ok: false,
    command: args.command,
    status: LOGIN_EXPIRED_STATUS,
    value: {
      workspace,
      project,
      login: { project: expired.project, expiresAt: expired.expiresAt, expiredForSeconds: expired.expiredForSeconds, sent: false },
      nextStep: step,
      trackUrl: args.trackUrl,
      ...(args.extra ?? {}),
    },
    error: {
      code: LOGIN_EXPIRED_CODE,
      name: "LoginExpired",
      message: `The login for ${expired.project} expired at ${expired.expiresAt} (${ago(expired.expiredForSeconds)}), so nothing was read or sent: this server drops an expired token instead of sending it, and the platform would have read the call as missing-token.`,
    },
    hint: `${step.say} The store page is ${args.trackUrl}.`,
  });
}
