// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { MANAGED_BROWSERS, REAL_BROWSERS } from "../lib/common-schema";
import { detectBrowsers } from "./detect-browsers";
import { listManagedBrowsers } from "./list-browsers";
import { installManagedBrowser } from "./install-browser";
import { uninstallManagedBrowser } from "./uninstall-browser";

export const schema = {
  name: "extension_browsers",
  description:
    "Find, install and remove the browsers Extension.js tooling can launch. Pass action:'detect' (the default) to scan both system-installed and managed browsers, and report each one's binary path, version, engine and debugger support. Pass action:'list' for the managed cache this tool downloads into, with sizes on disk. Pass action:'install' to download a managed binary: 580 to 625 MB in one blocking call, so allow a generous client timeout. Pass action:'uninstall' to remove managed binaries; it never touches a system install.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["detect", "list", "install", "uninstall"],
        default: "detect",
      },
      browsers: {
        type: "array",
        items: { type: "string", enum: REAL_BROWSERS },
        description: "detect: limit the scan to these. Omit to check all.",
      },
      browser: {
        type: "string",
        enum: MANAGED_BROWSERS,
        description:
          "install/uninstall: which managed binary. Required for install.",
      },
      all: {
        type: "boolean",
        default: false,
        description: "uninstall: remove every managed binary.",
      },
    },
    required: [],
  },
};

export async function handler(args: {
  action?: string;
  browsers?: string[];
  browser?: string;
  all?: boolean;
}): Promise<string> {
  const action = args.action ?? "detect";

  if (action === "list") return listManagedBrowsers();

  if (action === "install") {
    if (!args.browser) {
      return JSON.stringify({
        ok: false,
        status: "error",
        message:
          "action 'install' needs a browser: one of chrome, chromium, edge, firefox.",
      });
    }
    return installManagedBrowser(args.browser);
  }

  if (action === "uninstall") {
    return uninstallManagedBrowser({ browser: args.browser, all: args.all });
  }

  return detectBrowsers(args.browsers);
}
