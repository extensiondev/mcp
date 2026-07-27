// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { clearCredentials, readCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { consoleProjectUrl } from "../lib/registry";

export async function clearLocalCredentials(): Promise<string> {
  const creds = readCredentials();
  const revokeUrl =
    creds?.workspaceSlug && creds?.projectSlug
      ? consoleProjectUrl(
          { workspace: creds.workspaceSlug, project: creds.projectSlug },
          "settings/access-tokens",
        )
      : null;
  const result = clearCredentials();
  return envelope({
    ok: true,
    command: "extension_auth",
    status: result.cleared ? "logged-out" : "nothing-to-clear",
    value: {
      cleared: result.cleared,
      revokeUrl: result.cleared && revokeUrl ? revokeUrl : null,
    },
    hint: result.cleared
      ? revokeUrl
        ? `Local credentials removed. The token stays valid server-side until it expires; revoke it now at ${revokeUrl} (takes about a minute to propagate).`
        : "Local credentials removed. The token stays valid server-side until it expires; revoke it from the project's access-tokens page if needed."
      : "No stored credentials to remove.",
  });
}
