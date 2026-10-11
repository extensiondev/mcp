// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { loginToProject, loginToProjects } from "./login";
import { readIdentity } from "./whoami";
import { clearLocalCredentials } from "./logout";

export const schema = {
  name: "extension_auth",
  description:
    "Sign this machine in to extension.dev, report that login, or clear it. Pass action:'status' (the default) to name the workspace and project the stored token is scoped to and when it expires, never the token itself; that identity comes from the stored token alone, and does not change with the current working directory or whichever project folder you are in. Status also asks the platform's whoami endpoint whether that credential actually resolves there: the answer rides value.server.verdict as confirmed, refused or unavailable (when the server could not be reached), with status logged-in for the first and last and refused-by-server for the second, so a local file claiming a login the server refused is never reported as logged in. Pass action:'login' for a two-phase flow: call with `project` to get a code plus a URL the user authorizes at extension.dev/device, then call again with the returned `deviceCode`. GitHub federation happens server-side, so no GitHub token lands on this machine. Minted tokens live at most 7 days, server-enforced, so CI must re-mint before expiry on the console's project settings, Access tokens page. Pass action:'logout' to delete the local credentials only (with `project`, just that project's login); the token stays valid server-side until it is revoked at the URL the response returns. Several logins live side by side on one machine, one per server and workspace/project, and status lists them all under `logins`; a call uses the login minted on the server it targets (`api`, else EXTENSION_DEV_API_URL, else production), so a local dev server login never replaces or stands in for a production one. To sign in to several existing projects of one workspace at once, pass `projects` instead of `project`: one approval, one stored token per project.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "login", "logout"],
        default: "status",
      },
      project: {
        type: "string",
        description:
          "login: target project as '<workspace>/<project>'; the token is scoped to it. The slug pair is the console address bar: an existing project's page is console.extension.dev/<workspace>/<project>. Create one at extension.dev/new if none exists yet. Logins to several projects are all kept, the latest is the default; token-scoped tools take `project` to pick another. logout: remove only this project's login (omitted, every stored login goes).",
      },
      projects: {
        type: "array",
        items: { type: "string" },
        description:
          "login: sign in to several existing projects of one workspace with one approval, instead of one approval each. 1 to 20 names as '<workspace>/<project>', all in the same workspace, each by its exact slug (lowercase letters and digits joined by single dashes, at most 48 characters), none twice. Pass it instead of `project`, never beside it. The approval page lists every name; one missing project refuses the whole list and mints nothing. Resume with the returned `deviceCode` and the same list. Every token is stored as that project's own login and all expire within 7 days, so the same call renews them together.",
      },
      deviceCode: {
        type: "string",
        description:
          "login: resume token from the prior call's `deviceCode`; omit on the first call.",
      },
      api: API_BASE,
    },
    required: [],
  },
};

function listMisuse(message: string): string {
  return envelope({
    ok: false,
    command: "extension_auth",
    status: "bad-request",
    error: { code: "E_BAD_REQUEST", name: "BadRequest", message },
  });
}

export async function handler(args: {
  action?: string;
  project?: string;
  projects?: unknown;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const action = args.action ?? "status";
  const hasList = args.projects !== undefined && args.projects !== null;

  if (hasList && action !== "login") {
    return listMisuse(
      `projects is a login input: action '${action}' does not take a list. Use project to name one login, or call once per project.`,
    );
  }

  if (action === "logout") return clearLocalCredentials(args.project, args.api);

  if (action === "login" && hasList) {
    if (String(args.project ?? "").trim()) {
      return listMisuse(
        "Pass either project (one login) or projects (one approval for several), not both.",
      );
    }

    return loginToProjects({
      projects: args.projects,
      deviceCode: args.deviceCode,
      api: args.api,
    });
  }

  if (action === "login") {
    return loginToProject({
      project: String(args.project ?? ""),
      deviceCode: args.deviceCode,
      api: args.api,
    });
  }

  return readIdentity(undefined, args.api);
}
