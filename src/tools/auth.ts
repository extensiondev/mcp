// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { loginToProject } from "./login";
import { readIdentity } from "./whoami";
import { clearLocalCredentials } from "./logout";

export const schema = {
  name: "extension_auth",
  description:
    "Sign this machine in to extension.dev, report that login, or clear it. Pass action:'status' (the default) to name the workspace and project the stored token is scoped to and when it expires, never the token itself; that identity comes from the stored token alone, and does not change with the current working directory or whichever project folder you are in. Status also asks the platform's whoami endpoint whether that credential actually resolves there: the answer is reported as confirmed, refused-by-server, or unverified when the server cannot be reached, so a local file claiming a login the server would refuse is never reported as simply logged in. Pass action:'login' for a two-phase flow: call with `project` to get a code plus a URL the user authorizes at extension.dev/device, then call again with the returned `deviceCode`. GitHub federation happens server-side, so no GitHub token lands on this machine. Minted tokens live at most 7 days, server-enforced, so CI must re-mint before expiry on the console's project settings, Access tokens page. Pass action:'logout' to delete the local credentials only (with `project`, just that project's login); the token stays valid server-side until it is revoked at the URL the response returns. Several logins live side by side on one machine, one per workspace/project, and status lists them all under `logins`.",
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

export async function handler(args: {
  action?: string;
  project?: string;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const action = args.action ?? "status";

  if (action === "logout") return clearLocalCredentials(args.project);

  if (action === "login") {
    return loginToProject({
      project: String(args.project ?? ""),
      deviceCode: args.deviceCode,
      api: args.api,
    });
  }

  return readIdentity();
}
