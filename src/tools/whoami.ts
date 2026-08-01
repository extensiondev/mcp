// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
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
 *
 * Before this check, status said "logged-in" for any unexpired bytes in
 * auth.json, including a token the platform had revoked or one minted for a
 * different environment's audience, because no endpoint answered identity for
 * a bearer token. Now the platform's /api/cli/whoami is asked with the same
 * credential every authenticated tool sends, and its verdict is reported AS
 * the server's verdict: a refusal flips the status to refused-by-server, and
 * an unreachable or endpoint-less server is said out loud instead of being
 * dressed up as confirmation. The one thing this must never do is fall back
 * to the local claim in a way that reads as server-confirmed.
 */
function describeServer(check: ServerCheck, api: string) {
  if (check.kind === "confirmed") {
    return {
      status: "logged-in",
      note: `The server at ${api} confirms this token: it resolves to ${check.login} and is live there.`,
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
  if (!creds) {
    return envelope({
      ok: true,
      command: "extension_auth",
      status: "logged-out",
      value: {},
      hint: "No stored credentials. Run extension_auth (action: login) to authenticate.",
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
  const envTokenNote = envTokenSet
    ? "EXTENSION_DEV_TOKEN is set and takes precedence over this stored login for authenticated tools; this report describes only the stored login."
    : null;

  const message = [
    identityNote,
    server.note,
    server.warning,
    apiDivergesNote,
    envTokenNote,
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
    },
    hint: message,
    warnings: [
      tokenTtlNote(creds.workspaceSlug, creds.projectSlug),
      server.warning,
      apiDivergesNote,
      envTokenNote,
    ],
  });
}
