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

export async function clearLocalCredentials(project?: string, api?: string): Promise<string> {
  const wanted = String(project ?? "").trim();
  const creds = wanted ? readCredentials({ project: wanted, api }) : null;
  const revokeUrl =
    creds?.workspaceSlug && creds?.projectSlug
      ? consoleProjectUrl(
          { workspace: creds.workspaceSlug, project: creds.projectSlug },
          "settings/access-tokens",
          api,
        )
      : null;

  const revokeUrlFor = (key: string): string | null => {
    const [workspaceSlug, projectSlug] = (key.split(" ").pop() ?? "").split("/");

    return workspaceSlug && projectSlug
      ? consoleProjectUrl({ workspace: workspaceSlug, project: projectSlug }, "settings/access-tokens", api)
      : null;
  };

  const result = clearCredentials({ ...(wanted ? { project: wanted } : {}), api });
  const scope = wanted
    ? `the login for ${creds ? `${creds.workspaceSlug}/${creds.projectSlug}` : wanted}`
    : result.removed.length > 1
      ? `all ${result.removed.length} stored logins`
      : "the stored login";

  if (result.failure) {
    return envelope({
      ok: false,
      command: "extension_auth",
      status: "logout-failed",
      error: {
        code: "E_CONFIG",
        name: "LogoutFailed",
        message: `Nothing was removed: ${result.failure}.`,
      },
      value: {
        cleared: false,
        removed: [],
        remaining: result.remaining,
        path: result.path,
      },
      hint: `The token is still stored on this machine and token-scoped tools still use it. Fix what stopped the removal at ${result.path} and log out again${revokeUrl ? `, or revoke the token itself at ${revokeUrl}, which ends it wherever it is stored` : ", or revoke the token from the project's access-tokens page, which ends it wherever it is stored"}.`,
    });
  }

  return envelope({
    ok: true,
    command: "extension_auth",
    status: result.cleared ? "logged-out" : "nothing-to-clear",
    value: {
      cleared: result.cleared,
      removed: result.removed,
      remaining: result.remaining,
      revokeUrl: result.cleared && revokeUrl ? revokeUrl : null,
      ...(result.cleared && result.removed.length > 1
        ? { revokeUrls: Object.fromEntries(result.removed.map((key) => [key, revokeUrlFor(key)])) }
        : {}),
    },
    hint: result.cleared
      ? `Removed ${scope} from this machine${result.remaining.length ? `; ${result.remaining.length} other login${result.remaining.length === 1 ? "" : "s"} stay (${result.remaining.join(", ")})` : ""}. The token stays valid server-side until it expires; ${revokeUrl ? `revoke it now at ${revokeUrl} (takes about a minute to propagate)` : "revoke it from the project's access-tokens page if needed"}.`
      : wanted
        ? `No stored login matches ${wanted}. extension_auth (action: status) lists the logins on this machine.`
        : "No stored credentials to remove.",
  });
}
