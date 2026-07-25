// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readCredentials } from "../lib/credentials";
import { resolveApiBase, tokenTtlNote } from "../lib/login-flow";

export const schema = {
  name: "extension_whoami",
  description:
    "Report the identity carried by the locally stored extension.dev token that extension_login minted (workspace/project scoped), plus its expiry, without revealing the token. The identity comes from that stored token alone; it does not change with the current working directory or whichever project folder you are in. The result records where the login was minted (apiRecordedAtLogin) without asserting a platform base URL: authenticated tools target their own api argument, EXTENSION_DEV_API_URL, or the production default. Returns logged-out status when no credentials are stored.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function handler(): Promise<string> {
  const creds = readCredentials();
  if (!creds) {
    return JSON.stringify({
      ok: true,
      status: "logged-out",
      message: "No stored credentials. Run extension_login to authenticate.",
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

  const messageParts: string[] = [];
  messageParts.push(
    expired
      ? "The stored token has expired. Run extension_login to refresh it."
      : `Logged in as ${creds.workspaceSlug}/${creds.projectSlug}, per the token extension_login stored on this machine. That token is what scopes the identity: it does not follow the current working directory or project folder.`,
  );
  if (apiDiverges) {
    messageParts.push(
      `This login was minted via ${recordedApi}, but authenticated tools do not read that recorded value: they target ${effectiveDefaultApi} unless given an api argument.`,
    );
  }
  if (envTokenSet) {
    messageParts.push(
      "EXTENSION_DEV_TOKEN is set and takes precedence over this stored login for authenticated tools; this report describes only the stored login.",
    );
  }

  return JSON.stringify({
    ok: true,
    status: expired ? "expired" : "logged-in",
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
    ...(envTokenSet ? { envTokenOverride: true } : {}),
    tokenTtlNote: tokenTtlNote(creds.workspaceSlug, creds.projectSlug),
    message: messageParts.join(" "),
  });
}
