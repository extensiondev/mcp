// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { readCredentials } from "../lib/credentials";

export const schema = {
  name: "extension_whoami",
  description:
    "Report the locally stored extension.dev login (workspace/project and token expiry) without revealing the token. Returns logged-out status when no credentials are stored.",
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
  return JSON.stringify({
    ok: true,
    status: expired ? "expired" : "logged-in",
    workspaceSlug: creds.workspaceSlug,
    projectSlug: creds.projectSlug,
    api: creds.api,
    expiresAt: creds.expiresAt
      ? new Date(creds.expiresAt * 1000).toISOString()
      : null,
    expiresInSeconds: creds.expiresAt ? creds.expiresAt - now : null,
    expired,
    message: expired
      ? "Stored token has expired. Run extension_login to refresh it."
      : `Logged in to ${creds.workspaceSlug}/${creds.projectSlug}.`,
  });
}
