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
    "Report the identity carried by the locally stored extension.dev token that extension_login minted (workspace/project scoped), plus its expiry, without revealing the token. The identity comes from that stored token alone; it does not change with the current working directory or whichever project folder you are in. Returns logged-out status when no credentials are stored.",
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
    // Which device flow minted the stored token. Tokens predating the
    // extension.dev-gated flow have no recorded provider and were GitHub-direct.
    provider: creds.provider ?? "github",
    expiresAt: creds.expiresAt
      ? new Date(creds.expiresAt * 1000).toISOString()
      : null,
    expiresInSeconds: creds.expiresAt ? creds.expiresAt - now : null,
    expired,
    message: expired
      ? "The stored token has expired. Run extension_login to refresh it."
      : `Logged in as ${creds.workspaceSlug}/${creds.projectSlug}, per the token extension_login stored on this machine. That token is what scopes the identity: it does not follow the current working directory or project folder.`,
  });
}
