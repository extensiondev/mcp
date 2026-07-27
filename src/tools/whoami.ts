// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { resolveApiBase, tokenTtlNote } from "../lib/login-flow";

export async function readIdentity(): Promise<string> {
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

  const envTokenSet = Boolean(
    String(process.env.EXTENSION_DEV_TOKEN || "").trim(),
  );

  const identityNote = expired
    ? "The stored token has expired. Run extension_auth (action: login) to refresh it."
    : `Logged in as ${creds.workspaceSlug}/${creds.projectSlug}, per the token extension_auth stored on this machine. That token is what scopes the identity: it does not follow the current working directory or project folder.`;
  const apiDivergesNote = apiDiverges
    ? `This login was minted via ${recordedApi}: access grants for private registry reads use that recorded base when no api argument is given, while other authenticated tools target ${effectiveDefaultApi} unless given one.`
    : null;
  const envTokenNote = envTokenSet
    ? "EXTENSION_DEV_TOKEN is set and takes precedence over this stored login for authenticated tools; this report describes only the stored login."
    : null;

  const message = [identityNote, apiDivergesNote, envTokenNote]
    .filter(Boolean)
    .join(" ");

  return envelope({
    ok: true,
    command: "extension_auth",
    status: expired ? "expired" : "logged-in",
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
    },
    hint: message,
    warnings: [
      tokenTtlNote(creds.workspaceSlug, creds.projectSlug),
      apiDivergesNote,
      envTokenNote,
    ],
  });
}
