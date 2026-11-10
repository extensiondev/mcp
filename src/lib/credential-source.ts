// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { approvalLogin } from "./approval-scope";
import { envToken } from "./credential-scope";
import {
  MEMBER_PROJECT,
  defaultLoginDrift,
  expiredStoredLogin,
  isMemberLogin,
  loginDriftSentence,
  loginMoveSentence,
  memberProjects,
  pinnedProject,
  readValidCredentials,
  type ExpiredLogin,
  type StoredCredentials,
} from "./credentials";
import { deferWarning } from "./deferred-warnings";

export interface CredentialRef {
  workspace: string;
  project: string;
}

export interface TokenClaims extends CredentialRef {
  expiresAt: number | null;
  tokenId: string | null;
  member: boolean;
  projects: string[];
}

export const MEMBER_LANE = "member";

export function readTokenClaims(token: string): TokenClaims | null {
  const first = String(token ?? "").trim().split(".")[0];
  if (!first) return null;

  try {
    const padded = first.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (first.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      u?: unknown;
      p?: unknown;
      n?: unknown;
      l?: unknown;
      ps?: unknown;
      exp?: unknown;
    };
    const workspace = String(parsed?.u ?? "").trim().toLowerCase();
    const project = String(parsed?.p ?? "").trim().toLowerCase();
    if (!workspace || !project) return null;

    const member = String(parsed?.l ?? "").trim().toLowerCase() === MEMBER_LANE;
    const projects = member && Array.isArray(parsed.ps) ? parsed.ps.map((slug) => String(slug ?? "").trim().toLowerCase()).filter(Boolean) : [];

    return {
      workspace,
      project: member ? MEMBER_PROJECT : project,
      expiresAt: typeof parsed.exp === "number" && Number.isFinite(parsed.exp) ? parsed.exp : null,
      tokenId: String(parsed?.n ?? "").trim() || null,
      member,
      projects,
    };
  } catch {
    return null;
  }
}

export function claimsCover(claims: TokenClaims, ref: CredentialRef): boolean {
  if (claims.workspace !== ref.workspace.toLowerCase()) return false;

  const project = ref.project.toLowerCase();

  return claims.member ? claims.projects.includes(project) : claims.project === project;
}

function claimsRef(claims: TokenClaims | null): CredentialRef | null {
  if (!claims) return null;
  if (!claims.member) return { workspace: claims.workspace, project: claims.project };

  return claims.projects.length === 1 ? { workspace: claims.workspace, project: claims.projects[0] as string } : null;
}

export function memberNeedsProjectNote(login: Pick<StoredCredentials, "workspaceSlug" | "kind" | "projectSlugs">): string {
  return `The default login for this server is the member login for ${login.workspaceSlug.toLowerCase()}, which reads ${memberProjects(login).join(", ")}; it is sent only for a project the call names, so pass project: "${login.workspaceSlug.toLowerCase()}/<project>" (or projectPath).`;
}

function envMemberNote(claims: TokenClaims): string {
  return `EXTENSION_DEV_TOKEN is a member login for ${claims.workspace} (${claims.projects.join(", ") || "no project listed"}); it is sent only for a project the call names, so pass project: "${claims.workspace}/<project>".`;
}

export function loginIdOf(token: string): string {
  const value = String(token ?? "").trim();
  if (!value) return "";

  return readTokenClaims(value)?.tokenId ?? `sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function splitRef(name: string): CredentialRef | null {
  const [workspace, project, ...rest] = String(name ?? "").trim().split("/");
  if (!workspace || !project || rest.length) return null;

  return { workspace: workspace.toLowerCase(), project: project.toLowerCase() };
}

function sameRef(a: CredentialRef | null, b: CredentialRef | null): boolean {
  return (
    !!a &&
    !!b &&
    a.workspace.toLowerCase() === b.workspace.toLowerCase() &&
    a.project.toLowerCase() === b.project.toLowerCase()
  );
}

export interface ResolvedCredential {
  token: string;
  source: "stored" | "env" | "none";
  ref: CredentialRef | null;
  refSource: "stored" | "named" | "env-claims" | "none";
  mismatch: { env: CredentialRef; stored: CredentialRef } | null;
  note: string | null;
  expired: ExpiredLogin | null;
}

export function resolveCredential(options: { project?: string; api?: string } = {}): ResolvedCredential {
  const named = String(options.project ?? "").trim();
  const api = String(options.api ?? "").trim() || undefined;
  const held = approvalLogin();

  if (held) {
    return {
      token: String(held.token).trim(),
      source: "stored",
      ref: { workspace: held.workspaceSlug, project: held.projectSlug },
      refSource: "stored",
      mismatch: null,
      note: null,
      expired: null,
    };
  }

  const pinned = pinnedProject();
  const wanted = named || pinned;
  const env = envToken();
  const envClaims = env ? readTokenClaims(env) : null;
  const envRef = claimsRef(envClaims);

  if (wanted) {
    const creds = readValidCredentials(undefined, { project: wanted, api });

    if (creds?.token && !(isMemberLogin(creds) && creds.projectSlug === MEMBER_PROJECT)) {
      const moved = creds.movedFrom
        ? loginMoveSentence(creds.movedFrom, `${creds.workspaceSlug}/${creds.projectSlug}`.toLowerCase())
        : null;

      if (moved) deferWarning(moved);

      return {
        token: String(creds.token).trim(),
        source: "stored",
        ref: { workspace: creds.workspaceSlug, project: creds.projectSlug },
        refSource: "stored",
        mismatch: null,
        note: moved,
        expired: null,
      };
    }

    const wantedRef = splitRef(wanted);
    const expired = expiredStoredLogin({ project: wanted, api });

    if (named) {
      return {
        token: "",
        source: "none",
        ref: wantedRef,
        refSource: "named",
        mismatch: null,
        note: expired ? `The stored login for ${expired.project} expired at ${expired.expiresAt}.` : `No stored login for ${named}. Run extension_auth (action: login) for it.`,
        expired,
      };
    }

    if (env) {
      const covered = Boolean(wantedRef && envClaims && claimsCover(envClaims, wantedRef));
      const mismatch = wantedRef && envRef && !covered ? { env: envRef, stored: wantedRef } : null;

      return {
        token: env,
        source: "env",
        ref: covered ? wantedRef : (envRef ?? wantedRef),
        refSource: envRef || covered ? "env-claims" : "named",
        mismatch,
        note: mismatch
          ? `This server is pinned to ${wantedRef!.workspace}/${wantedRef!.project}, which has no stored login, and EXTENSION_DEV_TOKEN belongs to ${envRef!.workspace}/${envRef!.project} per its claims; the call is made as the token's project.`
          : envClaims?.member && !covered
            ? envMemberNote(envClaims)
            : null,
        expired: null,
      };
    }

    return { token: "", source: "none", ref: wantedRef, refSource: "named", mismatch: null, note: null, expired };
  }

  if (env) {
    const active = readValidCredentials(undefined, { api });
    const storedRef: CredentialRef | null =
      active?.workspaceSlug && active?.projectSlug && active.projectSlug !== MEMBER_PROJECT
        ? { workspace: active.workspaceSlug, project: active.projectSlug }
        : null;
    const mismatch = envRef && storedRef && !sameRef(envRef, storedRef) ? { env: envRef, stored: storedRef } : null;

    return {
      token: env,
      source: "env",
      ref: envRef,
      refSource: envRef ? "env-claims" : "none",
      mismatch,
      note: envClaims?.member && !envRef
        ? envMemberNote(envClaims)
        : !envRef
          ? storedRef
            ? `EXTENSION_DEV_TOKEN is set but its claims could not be read, so the project it belongs to is unknown; the stored login for ${storedRef.workspace}/${storedRef.project} is not assumed to be it, and project facts (builds, channels, console links) are not read for this call. Pass project: "${storedRef.workspace}/${storedRef.project}" to use that login.`
            : null
          : mismatch
            ? `EXTENSION_DEV_TOKEN belongs to ${envRef!.workspace}/${envRef!.project} per its claims while the active stored login is ${storedRef!.workspace}/${storedRef!.project}; this call is made as, and reports facts for, the token's project.`
            : null,
      expired: null,
    };
  }

  const creds = readValidCredentials(undefined, { api });

  if (creds?.token && isMemberLogin(creds) && creds.projectSlug === MEMBER_PROJECT) {
    return { token: "", source: "none", ref: null, refSource: "none", mismatch: null, note: memberNeedsProjectNote(creds), expired: null };
  }

  if (creds?.token) {
    const drift = defaultLoginDrift(api);

    return {
      token: String(creds.token).trim(),
      source: "stored",
      ref: { workspace: creds.workspaceSlug, project: creds.projectSlug },
      refSource: "stored",
      mismatch: null,
      note: drift ? loginDriftSentence(drift) : null,
      expired: null,
    };
  }

  const expired = expiredStoredLogin({ api });

  return { token: "", source: "none", ref: null, refSource: "none", mismatch: null, note: null, expired };
}

export function laneClosedByServer(err: unknown, code: string): boolean {
  return String((err as { serverCode?: unknown })?.serverCode ?? "").trim() === code;
}
