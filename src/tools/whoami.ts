// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  MEMBER_PROJECT,
  isMemberLogin,
  loginDriftSentence,
  memberLabel,
  memberProjects,
  type CredentialSelector,
  type StoredCredentials,
} from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { AUTH_LOCAL } from "./auth-local";
import { readTokenClaims, type ResolvedCredential } from "../lib/credential-source";
import { envToken, requestCredential } from "../lib/credential-scope";
import { targetServer } from "../lib/credential-server";
import { resolveApiBase, safeApiBase, tokenTtlNote } from "../lib/login-flow";
import {
  askServerIdentity,
  type ServerIdentityAnswer,
} from "../lib/server-identity";

export type StoredLoginEntry = StoredCredentials & { key: string; active: boolean; server: string };

export interface AuthLocal {
  readCredentials(selector?: CredentialSelector): StoredCredentials | null;
  credentialStoreProblem(): { path: string; reason: string } | null;
  listCredentials(): StoredLoginEntry[];
  defaultLoginDrift(api?: string): { kept: string; newest: string } | null;
  resolveCredential(options?: { project?: string; api?: string }): ResolvedCredential;
}

type ServerCheck =
  | ServerIdentityAnswer
  | { kind: "not-asked"; detail: string };

function describeServer(check: ServerCheck, api: string) {
  if (check.kind === "confirmed") {
    return {
      status: "logged-in",
      note: `The server at ${api} confirms this token: it resolves to ${check.login}${check.live ? " and is live there" : ", though the server does not report it live"}.`,
      warning: null,
      value: {
        verdict: "confirmed",
        api,
        login: check.login,
        live: check.live,
      },
    };
  }

  if (check.kind === "refused") {
    return {
      status: "refused-by-server",
      note: `The server at ${api} refused this credential: it does not resolve to an identity there (expired, revoked, or minted for another environment). The workspace/project above is only what the local file claims. Run extension_auth (action: login) to re-authenticate.`,
      warning: null,
      value: { verdict: "refused", api },
    };
  }

  if (check.kind === "unavailable") {
    return {
      status: "logged-in",
      note: null,
      warning: `Could not verify this login with the server at ${api} (${check.detail}). The identity above is the local file's claim only, not server-confirmed.`,
      value: { verdict: "unavailable", api, detail: check.detail },
    };
  }

  return {
    status: "expired",
    note: null,
    warning: null,
    value: { verdict: "not-asked", detail: check.detail },
  };
}

interface LoginRow {
  project: string;
  server: string;
  active: boolean;
  expiresAt: string | null;
  expired: boolean;
  kind?: "member";
  projects?: string[];
}

/* @invariant A MEMBER LOGIN IS ONE ROW WITH ITS PROJECT LIST. The store reads
 * it as one login per project it lists so that every tool finds it under the
 * project it names, but the person signed in once, so the report shows one
 * login for the workspace and the projects it reads, never a row per project.
 */
function loginRows(local: AuthLocal, now: number): LoginRow[] {
  const rows = new Map<string, LoginRow>();

  for (const entry of local.listCredentials()) {
    const ref = `${entry.workspaceSlug}/${entry.projectSlug}`;
    const member = isMemberLogin(entry);
    const key = `${entry.server} ${entry.key}`;
    const known = rows.get(key);

    if (known && member) {
      known.projects?.push(ref);
      continue;
    }

    rows.set(key, {
      project: member ? memberLabel(entry) : ref,
      server: entry.server,
      active: entry.active,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt * 1000).toISOString() : null,
      expired: Boolean(entry.expiresAt && entry.expiresAt <= now),
      ...(member ? { kind: "member" as const, projects: [ref] } : {}),
    });
  }

  return [...rows.values()];
}

function elsewhereNote(local: AuthLocal, server: string): { note: string; logins: Array<{ project: string; server: string }> } | null {
  const logins = loginRows(local, Math.floor(Date.now() / 1000))
    .filter((entry) => entry.server !== server)
    .map((entry) => ({ project: entry.project, server: entry.server }));
  if (logins.length === 0) return null;

  return {
    logins,
    note: `No stored login for ${server}, the server this call targets. This machine holds logins for other servers: ${logins.map((l) => `${l.project} on ${l.server}`).join(", ")}. Each login is used only against the server it was minted on: pass api (or set EXTENSION_DEV_API_URL) to that server to use one, or run extension_auth (action: login) to sign in to ${server}.`,
  };
}

function storedLogins(local: AuthLocal, target: string, now: number): LoginRow[] {
  return loginRows(local, now).map((row) => ({ ...row, active: row.active && row.server === target }));
}

function notSignedIn(local: AuthLocal, project: string, target: string, now: number): string {
  const logins = storedLogins(local, target, now);
  const onServer = logins.filter((login) => login.server === target);

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "not-signed-in",
    value: { project, server: target, logins },
    hint: `No stored login for ${project} on ${target}, so there is nothing to report or verify for it. Run extension_auth (action: login, project: "${project}") to sign in to it${onServer.length ? `; the logins this machine holds for ${target} are ${onServer.map((login) => login.project).join(", ")}, listed under logins` : ""}.`,
  });
}

export async function readIdentityWith(local: AuthLocal, deps?: {
  fetchImpl?: typeof fetch;
}, api?: string, project?: string): Promise<string> {
  const target = targetServer(api);
  const wanted = String(project ?? "").trim();
  const creds = local.readCredentials({ ...(wanted ? { project: wanted } : {}), api });
  const problem = creds ? null : local.credentialStoreProblem();

  if (problem) {
    return envelope({
      ok: false,
      command: "extension_auth",
      status: "store-unreadable",
      error: {
        code: "E_CONFIG",
        name: "CredentialStoreUnreadable",
        message: `The login store at ${problem.path} exists but ${problem.reason}, so the logins on this machine cannot be listed.`,
      },
      value: { path: problem.path },
      hint: "This is not a logged-out machine: the file is there and may hold logins. Fix or move it and run extension_auth (action: status) again; a new login is refused while it is unreadable, and extension_auth (action: logout) with no project removes it if its logins are not worth recovering.",
    });
  }

  if (wanted && !creds) return notSignedIn(local, wanted, target, Math.floor(Date.now() / 1000));

  const elsewhere = creds ? null : elsewhereNote(local, target);

  if (!creds && elsewhere && !envToken()) {
    return envelope({
      ok: true,
      command: "extension_auth",
      status: "logged-out",
      value: { server: target, logins: elsewhere.logins },
      hint: elsewhere.note,
    });
  }

  if (!creds) {
    return envelope({
      ok: true,
      command: "extension_auth",
      status: "logged-out",
      ...(envToken()
        ? {
            value: {
              envToken: (() => {
                const claims = readTokenClaims(envToken());

                return claims ? `${claims.workspace}/${claims.project}` : "unreadable claims";
              })(),
            },
          }
        : { value: {} }),
      hint: envToken()
        ? `No stored login, but EXTENSION_DEV_TOKEN is set and is what authenticated tools send${(() => {
            const claims = readTokenClaims(envToken());

            return claims ? ` (per its claims it belongs to ${claims.workspace}/${claims.project})` : " (its claims could not be read)";
          })()}. Run extension_auth (action: login) to store a login as well.`
        : "No stored credentials. Run extension_auth (action: login) to authenticate.",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = Boolean(creds.expiresAt && creds.expiresAt <= now);
  const member = isMemberLogin(creds);
  const listed = memberProjects(creds).map((slug) => `${creds.workspaceSlug}/${slug}`.toLowerCase());
  const namedProject = creds.projectSlug !== MEMBER_PROJECT ? creds.projectSlug : "";
  const askFor = namedProject || memberProjects(creds)[0] || "";
  const askRef = askFor ? { workspace: creds.workspaceSlug, project: askFor } : null;

  const recordedApi = String(creds.api || "").trim();
  const effectiveDefaultApi = resolveApiBase(api);
  const askApi = recordedApi || effectiveDefaultApi;

  const envTokenSet = Boolean(envToken());

  let check: ServerCheck;

  if (expired) {
    check = {
      kind: "not-asked",
      detail: "the stored token has already expired locally",
    };
  } else {
    const safe = safeApiBase(askApi);
    check = safe.ok
      ? await askServerIdentity({
          apiBase: safe.base,
          token: creds.token,
          ref: askRef,
          fetchImpl: deps?.fetchImpl,
        })
      : { kind: "unavailable", detail: safe.message };
  }

  const server = describeServer(check, askApi);

  const hosted = Boolean(requestCredential());
  const forwarded = requestCredential()?.kind === "forward";
  const slugs = member && !namedProject ? memberLabel(creds) : `${creds.workspaceSlug}/${creds.projectSlug}`;
  const memberRenew = `extension_auth (action: login, workspace: "${creds.workspaceSlug}", projects: "*")`;
  const hostedNote = forwarded
    ? expired
      ? "The short-lived forward credential for this call has expired. Call again: the local server exchanges its device login for a fresh one, and if extension.dev refuses that login, run extension_auth (action: login) on this machine."
      : `Signed in as ${slugs} through a short-lived forward credential the local server exchanged from this machine's device login, which scopes every call; the device login itself goes only to extension.dev, never to the hosted lane.`
    : expired
      ? "This connection's token has expired. Sign in again from your MCP client."
      : `Signed in as ${slugs} through this connection's OAuth token, which scopes every call.`;
  const identityNote = hosted
    ? hostedNote
    : member
      ? expired
        ? `The member login for ${creds.workspaceSlug} has expired. Run ${memberRenew} to refresh it.`
        : namedProject
          ? `${slugs} is read by the member login for ${creds.workspaceSlug}, one login that reads ${listed.join(", ")}; a token-scoped tool naming project: "${slugs}" sends it for that project.`
          : `Logged in to ${creds.workspaceSlug} as a member: one login reads ${listed.join(", ")}. It is sent for the project a call names with project (or projectPath); no project is assumed.`
      : wanted
        ? expired
          ? `The stored login for ${slugs} has expired. Run extension_auth (action: login, project: "${slugs}") to refresh it.`
          : `This is the login stored for ${slugs}, the one a token-scoped tool sends when it names project: "${slugs}"; the default login for unnamed calls may be another one.`
        : expired
          ? "The stored token has expired. Run extension_auth (action: login) to refresh it."
          : `Logged in as ${slugs}, per the token extension_auth stored on this machine. That token is what scopes the identity: it does not follow the current working directory or project folder.`;
  const resolved = local.resolveCredential({ api });
  const envTokenNote = envTokenSet
    ? `EXTENSION_DEV_TOKEN is set: an unnamed call sends it${resolved.ref ? ` (per its claims it belongs to ${resolved.ref.workspace}/${resolved.ref.project})` : " (its claims could not be read)"}, while a call naming a project, or a server pinned to one, sends that project's stored login first; this report describes only the stored login.`
    : null;
  const expectedLogin = askRef ? `${askRef.workspace}/${askRef.project}`.toLowerCase() : slugs.toLowerCase();
  const serverIdentityMismatch =
    check.kind === "confirmed" && check.login.toLowerCase() !== expectedLogin
      ? `The server resolves this token to ${check.login}, not to the ${expectedLogin} the stored file claims; the file's slugs are stale or were edited. Log in again to refresh them.`
      : null;
  const logins = wanted ? [] : storedLogins(local, target, now);
  const loginsNote =
    logins.length > 1
      ? `${logins.length} logins are stored on this machine (${logins.map((l) => (l.server === target ? l.project : `${l.project} on ${l.server}`)).join(", ")}); the one above is the default for token-scoped tools on ${target}, each of them takes \`project\` to use another, and a login minted on another server is used only when a call targets that server.`
      : null;
  const drift = hosted || wanted ? null : local.defaultLoginDrift(api);
  const driftNote = drift ? loginDriftSentence(drift) : null;

  const message = [
    identityNote,
    server.note,
    server.warning,
    envTokenNote,
    loginsNote,
    driftNote,
  ]
    .filter(Boolean)
    .join(" ");

  return envelope({
    ok: true,
    command: "extension_auth",
    status: expired ? "expired" : server.status,
    value: {
      workspaceSlug: creds.workspaceSlug,
      projectSlug: namedProject || null,
      ...(member ? { kind: "member", projects: listed } : {}),
      projectId: creds.projectId ?? null,
      ...(recordedApi ? { apiRecordedAtLogin: recordedApi } : {}),
      apiDefault: effectiveDefaultApi,
      provider: creds.provider ?? "extensiondev",
      expiresAt: creds.expiresAt
        ? new Date(creds.expiresAt * 1000).toISOString()
        : null,
      expiresInSeconds: creds.expiresAt ? creds.expiresAt - now : null,
      expired,
      server: server.value,
      ...(wanted ? {} : { logins }),
    },
    hint: message,
    warnings: [
      tokenTtlNote(creds.workspaceSlug, namedProject || undefined, creds.api),
      server.warning,
      serverIdentityMismatch,
      envTokenNote,
      driftNote,
    ],
  });
}

export async function readIdentity(deps?: {
  fetchImpl?: typeof fetch;
}, api?: string, project?: string): Promise<string> {
  return readIdentityWith(AUTH_LOCAL, deps, api, project);
}
