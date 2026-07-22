// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { clearCredentials, readCredentials } from "../lib/credentials";

export const schema = {
  name: "extension_logout",
  description:
    "Delete the locally stored extension.dev credentials. Does not revoke the token server-side (the response includes the dashboard URL where the token can be revoked); only removes it from this machine.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function handler(): Promise<string> {
  // Read before clearing: the revoke link needs the workspace/project the
  // token was scoped to, and after clearCredentials that scope is gone.
  const creds = readCredentials();
  const revokeUrl =
    creds?.workspaceSlug && creds?.projectSlug
      ? `https://console.extension.dev/${creds.workspaceSlug}/${creds.projectSlug}/settings/access-tokens`
      : null;
  const result = clearCredentials();
  return JSON.stringify({
    ok: true,
    cleared: result.cleared,
    ...(result.cleared && revokeUrl ? { revokeUrl } : {}),
    message: result.cleared
      ? revokeUrl
        ? `Local credentials removed. The token stays valid server-side until it expires; revoke it now at ${revokeUrl} (takes about a minute to propagate).`
        : "Local credentials removed. The token stays valid server-side until it expires; revoke it from the project's access-tokens page if needed."
      : "No stored credentials to remove.",
  });
}
