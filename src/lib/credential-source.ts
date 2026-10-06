// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { pinnedProject, readValidCredentials } from "./credentials";

export interface CredentialRef {
  workspace: string;
  project: string;
}

export interface TokenClaims extends CredentialRef {
  expiresAt: number | null;
}

/* @invariant THE TOKEN NAMES ITS OWN PROJECT. A platform access token is
   `<base64url claims>.<signature>` and the claims carry `u` (workspace) and
   `p` (project), which is what the platform itself compares a bearer
   against. Reading them here names the project an EXTENSION_DEV_TOKEN is
   for without a network call; nothing is verified, the signature is the
   platform's to check. */
export function readTokenClaims(token: string): TokenClaims | null {
  const first = String(token ?? "").trim().split(".")[0];
  if (!first) return null;
  try {
    const padded = first.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (first.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      u?: unknown;
      p?: unknown;
      exp?: unknown;
    };
    const workspace = String(parsed?.u ?? "").trim().toLowerCase();
    const project = String(parsed?.p ?? "").trim().toLowerCase();
    if (!workspace || !project) return null;
    return {
      workspace,
      project,
      expiresAt: typeof parsed.exp === "number" && Number.isFinite(parsed.exp) ? parsed.exp : null,
    };
  } catch {
    return null;
  }
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
}

/* @invariant ONE RESOLVER ANSWERS THE TOKEN AND THE PROJECT IT BELONGS TO.
   The token came from one reader and the project from another (the ACTIVE
   stored login), so an EXTENSION_DEV_TOKEN for project A was sent while the
   build index, store health, channels and console links in the same answer
   were B's. A named project, or a server pinned to one,
   sends that project's stored login first; an unnamed call sends the env
   token first and takes its project from the token's own claims, never
   from whichever login happens to be active. */
export function resolveCredential(options: { project?: string } = {}): ResolvedCredential {
  const named = String(options.project ?? "").trim();
  const pinned = pinnedProject();
  const wanted = named || pinned;
  const env = String(process.env.EXTENSION_DEV_TOKEN || "").trim();
  const envClaims = env ? readTokenClaims(env) : null;
  const envRef: CredentialRef | null = envClaims ? { workspace: envClaims.workspace, project: envClaims.project } : null;

  if (wanted) {
    const creds = readValidCredentials(undefined, { project: wanted });
    if (creds?.token) {
      return {
        token: String(creds.token).trim(),
        source: "stored",
        ref: { workspace: creds.workspaceSlug, project: creds.projectSlug },
        refSource: "stored",
        mismatch: null,
        note: null,
      };
    }
    const wantedRef = splitRef(wanted);
    if (named) {
      return {
        token: "",
        source: "none",
        ref: wantedRef,
        refSource: "named",
        mismatch: null,
        note: `No stored login for ${named}. Run extension_auth (action: login) for it.`,
      };
    }
    if (env) {
      const mismatch = wantedRef && envRef && !sameRef(wantedRef, envRef) ? { env: envRef, stored: wantedRef } : null;
      return {
        token: env,
        source: "env",
        ref: envRef ?? wantedRef,
        refSource: envRef ? "env-claims" : "named",
        mismatch,
        note: mismatch
          ? `This server is pinned to ${wantedRef!.workspace}/${wantedRef!.project}, which has no stored login, and EXTENSION_DEV_TOKEN belongs to ${envRef!.workspace}/${envRef!.project} per its claims; the call is made as the token's project.`
          : null,
      };
    }
    return { token: "", source: "none", ref: wantedRef, refSource: "named", mismatch: null, note: null };
  }

  if (env) {
    const active = readValidCredentials();
    const storedRef: CredentialRef | null =
      active?.workspaceSlug && active?.projectSlug
        ? { workspace: active.workspaceSlug, project: active.projectSlug }
        : null;
    const mismatch = envRef && storedRef && !sameRef(envRef, storedRef) ? { env: envRef, stored: storedRef } : null;
    return {
      token: env,
      source: "env",
      ref: envRef,
      refSource: envRef ? "env-claims" : "none",
      mismatch,
      note: !envRef
        ? storedRef
          ? `EXTENSION_DEV_TOKEN is set but its claims could not be read, so the project it belongs to is unknown; the stored login for ${storedRef.workspace}/${storedRef.project} is not assumed to be it, and project facts (builds, channels, console links) are not read for this call. Pass project: "${storedRef.workspace}/${storedRef.project}" to use that login.`
          : null
        : mismatch
          ? `EXTENSION_DEV_TOKEN belongs to ${envRef!.workspace}/${envRef!.project} per its claims while the active stored login is ${storedRef!.workspace}/${storedRef!.project}; this call is made as, and reports facts for, the token's project.`
          : null,
    };
  }

  const creds = readValidCredentials();
  if (creds?.token) {
    return {
      token: String(creds.token).trim(),
      source: "stored",
      ref: { workspace: creds.workspaceSlug, project: creds.projectSlug },
      refSource: "stored",
      mismatch: null,
      note: null,
    };
  }
  return { token: "", source: "none", ref: null, refSource: "none", mismatch: null, note: null };
}

/* The project an authenticated call acts on: the one the token belongs to. */
export function credentialProjectRef(selector?: string): CredentialRef | null {
  return resolveCredential({ project: selector }).ref;
}

/* @invariant A LANE IS CLOSED ON THE SERVER'S CODE ONLY. Matching the
   digits 403 in a sentence read a proxy or firewall refusal as "not on the
   allowlist". */
export function laneClosedByServer(err: unknown, code: string): boolean {
  return String((err as { serverCode?: unknown })?.serverCode ?? "").trim() === code;
}
