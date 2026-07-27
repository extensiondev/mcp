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
    "Sign this machine in to extension.dev, report that login, or clear it. Pass action:'status' (the default) to name the workspace and project the stored token is scoped to and when it expires, never the token itself; that identity comes from the stored token alone, and does not change with the current working directory or whichever project folder you are in. Pass action:'login' for a two-phase flow: call with `project` to get a code plus a URL the user authorizes at extension.dev/device, then call again with the returned `deviceCode`. GitHub federation happens server-side, so no GitHub token lands on this machine. Minted tokens live at most 7 days, server-enforced, so CI must re-mint before expiry on the console's project settings, Access tokens page. Pass action:'logout' to delete the local credentials only; the token stays valid server-side until it is revoked at the URL the response returns.",
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
          "login: target project as '<workspace>/<project>'; the token is scoped to it.",
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

  if (action === "logout") return clearLocalCredentials();

  if (action === "login") {
    return loginToProject({
      project: String(args.project ?? ""),
      deviceCode: args.deviceCode,
      api: args.api,
    });
  }

  return readIdentity();
}
