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

export async function clearLocalCredentials(project?: string): Promise<string> {
  const wanted = String(project ?? "").trim();
  const creds = readCredentials(wanted ? { project: wanted } : undefined);
  const revokeUrl =
    creds?.workspaceSlug && creds?.projectSlug
      ? consoleProjectUrl(
          { workspace: creds.workspaceSlug, project: creds.projectSlug },
          "settings/access-tokens",
        )
      : null;
  const result = clearCredentials(wanted ? { project: wanted } : undefined);
  const scope = wanted
    ? `the login for ${creds ? `${creds.workspaceSlug}/${creds.projectSlug}` : wanted}`
    : result.removed.length > 1
      ? `all ${result.removed.length} stored logins`
      : "the stored login";
  return envelope({
    ok: true,
    command: "extension_auth",
    status: result.cleared ? "logged-out" : "nothing-to-clear",
    value: {
      cleared: result.cleared,
      removed: result.removed,
      remaining: result.remaining,
      revokeUrl: result.cleared && revokeUrl ? revokeUrl : null,
    },
    hint: result.cleared
      ? `Removed ${scope} from this machine${result.remaining.length ? `; ${result.remaining.length} other login${result.remaining.length === 1 ? "" : "s"} stay (${result.remaining.join(", ")})` : ""}. The token stays valid server-side until it expires; ${revokeUrl ? `revoke it now at ${revokeUrl} (takes about a minute to propagate)` : "revoke it from the project's access-tokens page if needed"}.`
      : wanted
        ? `No stored login matches ${wanted}. extension_auth (action: status) lists the logins on this machine.`
        : "No stored credentials to remove.",
  });
}
