// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  credentialStoreProblem,
  listCredentials,
  readCredentials,
} from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { readTokenClaims, resolveCredential } from "../lib/credential-source";
import { resolveApiBase, safeApiBase, tokenTtlNote } from "../lib/login-flow";
import {
  askServerIdentity,
  type ServerIdentityAnswer,
} from "../lib/server-identity";

type ServerCheck =
  | ServerIdentityAnswer
  | { kind: "not-asked"; detail: string };

/* @invariant
  * THE LOCAL FILE CLAIMS, THE SERVER ANSWERS, AND THE TWO ARE NEVER BLENDED.
  * Now the platform's /api/cli/whoami is asked with the same credential every
  * authenticated tool sends, and its verdict is reported AS the server's
  * verdict: a refusal flips the status to refused-by-server, and an
  * unreachable or endpoint-less server is said out loud instead of being
  * dressed up as confirmation. The one thing this must never do is fall back
  * to the local claim in a way that reads as server-confirmed.
  */
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

export async function readIdentity(deps?: {
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const creds = readCredentials();
  const problem = creds ? null : credentialStoreProblem();

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

  if (!creds) {
    return envelope({
      ok: true,
      command: "extension_auth",
      status: "logged-out",
      ...(String(process.env.EXTENSION_DEV_TOKEN || "").trim()
        ? {
            value: {
              envToken: (() => {
                const claims = readTokenClaims(String(process.env.EXTENSION_DEV_TOKEN));

                return claims ? `${claims.workspace}/${claims.project}` : "unreadable claims";
              })(),
            },
          }
        : { value: {} }),
      hint: String(process.env.EXTENSION_DEV_TOKEN || "").trim()
        ? `No stored login, but EXTENSION_DEV_TOKEN is set and is what authenticated tools send${(() => {
            const claims = readTokenClaims(String(process.env.EXTENSION_DEV_TOKEN));

            return claims ? ` (per its claims it belongs to ${claims.workspace}/${claims.project})` : " (its claims could not be read)";
          })()}. Run extension_auth (action: login) to store a login as well.`
        : "No stored credentials. Run extension_auth (action: login) to authenticate.",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = Boolean(creds.expiresAt && creds.expiresAt <= now);

  const recordedApi = String(creds.api || "").trim();
  const effectiveDefaultApi = resolveApiBase();
  const apiDiverges = Boolean(recordedApi) && recordedApi !== effectiveDefaultApi;
  const askApi = recordedApi || effectiveDefaultApi;

  const envTokenSet = Boolean(
    String(process.env.EXTENSION_DEV_TOKEN || "").trim(),
  );

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
          fetchImpl: deps?.fetchImpl,
        })
      : { kind: "unavailable", detail: safe.message };
  }

  const server = describeServer(check, askApi);

  const identityNote = expired
    ? "The stored token has expired. Run extension_auth (action: login) to refresh it."
    : `Logged in as ${creds.workspaceSlug}/${creds.projectSlug}, per the token extension_auth stored on this machine. That token is what scopes the identity: it does not follow the current working directory or project folder.`;
  const apiDivergesNote = apiDiverges
    ? `This login was minted via ${recordedApi}: access grants for private registry reads use that recorded base when no api argument is given, while other authenticated tools target ${effectiveDefaultApi} unless given one.`
    : null;
  const resolved = resolveCredential();
  const envTokenNote = envTokenSet
    ? `EXTENSION_DEV_TOKEN is set: an unnamed call sends it${resolved.ref ? ` (per its claims it belongs to ${resolved.ref.workspace}/${resolved.ref.project})` : " (its claims could not be read)"}, while a call naming a project, or a server pinned to one, sends that project's stored login first; this report describes only the stored login.`
    : null;
  const serverIdentityMismatch =
    check.kind === "confirmed" && check.login.toLowerCase() !== `${creds.workspaceSlug}/${creds.projectSlug}`.toLowerCase()
      ? `The server resolves this token to ${check.login}, not to the ${creds.workspaceSlug}/${creds.projectSlug} the stored file claims; the file's slugs are stale or were edited. Log in again to refresh them.`
      : null;
  const logins = listCredentials().map((entry) => ({
    project: `${entry.workspaceSlug}/${entry.projectSlug}`,
    active: entry.active,
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt * 1000).toISOString() : null,
    expired: Boolean(entry.expiresAt && entry.expiresAt <= now),
  }));
  const loginsNote =
    logins.length > 1
      ? `${logins.length} logins are stored on this machine (${logins.map((l) => l.project).join(", ")}); the active one above is the default for token-scoped tools, and each of them takes \`project\` to use another.`
      : null;

  const message = [
    identityNote,
    server.note,
    server.warning,
    apiDivergesNote,
    envTokenNote,
    loginsNote,
  ]
    .filter(Boolean)
    .join(" ");

  return envelope({
    ok: true,
    command: "extension_auth",
    status: expired ? "expired" : server.status,
    value: {
      workspaceSlug: creds.workspaceSlug,
      projectSlug: creds.projectSlug,
      ...(recordedApi ? { apiRecordedAtLogin: recordedApi } : {}),
      apiDefault: effectiveDefaultApi,
      provider: creds.provider ?? "extensiondev",
      expiresAt: creds.expiresAt
        ? new Date(creds.expiresAt * 1000).toISOString()
        : null,
      expiresInSeconds: creds.expiresAt ? creds.expiresAt - now : null,
      expired,
      server: server.value,
      logins,
    },
    hint: message,
    warnings: [
      tokenTtlNote(creds.workspaceSlug, creds.projectSlug),
      server.warning,
      apiDivergesNote,
      serverIdentityMismatch,
      envTokenNote,
    ],
  });
}
