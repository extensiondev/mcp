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

export function resolveCredential(options: { project?: string; api?: string } = {}): ResolvedCredential {
  const named = String(options.project ?? "").trim();
  const api = String(options.api ?? "").trim() || undefined;
  const pinned = pinnedProject();
  const wanted = named || pinned;
  const env = String(process.env.EXTENSION_DEV_TOKEN || "").trim();
  const envClaims = env ? readTokenClaims(env) : null;
  const envRef: CredentialRef | null = envClaims ? { workspace: envClaims.workspace, project: envClaims.project } : null;

  if (wanted) {
    const creds = readValidCredentials(undefined, { project: wanted, api });

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
    const active = readValidCredentials(undefined, { api });
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

  const creds = readValidCredentials(undefined, { api });

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

export function laneClosedByServer(err: unknown, code: string): boolean {
  return String((err as { serverCode?: unknown })?.serverCode ?? "").trim() === code;
}
