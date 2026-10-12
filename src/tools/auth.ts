// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { loginToProject, loginToProjects, loginToWorkspace } from "./login";
import { WORKSPACE_WILDCARD } from "../lib/project-batch";
import { readIdentity } from "./whoami";
import { clearLocalCredentials } from "./logout";

export const schema = {
  name: "extension_auth",
  description:
    "Sign this machine in to extension.dev, report that login, or clear it. Pass action:'status' (the default) to name the workspace and project the stored token is scoped to and when it expires, never the token itself; that identity comes from the stored token alone, and does not change with the current working directory or whichever project folder you are in. Status also asks the platform's whoami endpoint whether that credential actually resolves there: the answer rides value.server.verdict as confirmed, refused or unavailable (when the server could not be reached), with status logged-in for the first and last and refused-by-server for the second, so a local file claiming a login the server refused is never reported as logged in. Pass action:'login' for a two-phase flow: call with `project` to get a code plus a URL the user authorizes at extension.dev/device, then call again with the returned `deviceCode`. GitHub federation happens server-side, so no GitHub token lands on this machine. Minted tokens live at most 7 days, server-enforced, so CI must re-mint before expiry on the console's project settings, Access tokens page. Pass action:'logout' to delete the local credentials only (with `project`, just that project's login); the token stays valid server-side until it is revoked at the URL the response returns. Several logins live side by side on one machine, one per server and workspace/project, and status lists them all under `logins`; a call uses the login minted on the server it targets (`api`, else EXTENSION_DEV_API_URL, else production), so a local dev server login never replaces or stands in for a production one. To sign in to several existing projects of one workspace at once, pass `projects` instead of `project`: one approval, one stored token per project. To sign in to every project a workspace has, pass `workspace` with projects:\"*\": the approval page lists them and the answer names each project signed in.",
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
        type: ["array", "string"],
        items: { type: "string" },
        description:
          "login: sign in to several existing projects of one workspace with one approval, instead of one approval each. 1 to 20 names as '<workspace>/<project>', all in the same workspace, each by its exact slug (lowercase letters and digits joined by single dashes, at most 48 characters), none twice. Pass it instead of `project`, never beside it. The approval page lists every name; one missing project refuses the whole list and mints nothing. Resume with the returned `deviceCode` and the same list. Every token is stored as that project's own login and all expire within 7 days, so the same call renews them together. Or pass the string \"*\" with `workspace` to sign in to every project that workspace has when the approver opens the page (at most 20); the answer names each project signed in.",
      },
      workspace: {
        type: "string",
        description:
          "login with projects: \"*\": the workspace slug whose every project to sign in to, with one approval. Only a project of this workspace is ever stored. A platform that does not offer it is refused before any code is spent.",
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
  workspace?: string;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const action = args.action ?? "status";
  const hasList = args.projects !== undefined && args.projects !== null;
  const hasWorkspace = String(args.workspace ?? "").trim() !== "";
  const wildcard = args.projects === WORKSPACE_WILDCARD;

  if (hasWorkspace && !wildcard) {
    return listMisuse(
      'workspace is a login input that goes with projects: "*" (every project of that workspace). To sign in to some of its projects, name them in projects instead.',
    );
  }

  if (typeof args.projects === "string" && !wildcard) {
    return listMisuse(
      `projects must be an array of '<workspace>/<project>' names, or the string "*" with workspace; got ${JSON.stringify(args.projects)}.`,
    );
  }

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

    if (wildcard) {
      return loginToWorkspace({
        workspace: args.workspace,
        deviceCode: args.deviceCode,
        api: args.api,
      });
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
