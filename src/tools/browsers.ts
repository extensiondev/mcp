// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { MANAGED_BROWSERS, REAL_BROWSERS } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { detectBrowsers } from "./detect-browsers";
import { listManagedBrowsers } from "./list-browsers";
import { installManagedBrowser } from "./install-browser";
import { uninstallManagedBrowser } from "./uninstall-browser";

export const schema = {
  name: "extension_browsers",
  description:
    "Find, install and remove browsers Extension.js launches. detect (default) scans system and managed ones; install downloads hundreds of MB in one blocking call; uninstall never touches a system install.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["detect", "list", "install", "uninstall"],
        default: "detect",
        description: "list reads the managed cache.",
      },
      browsers: {
        type: "array",
        items: { type: "string", enum: REAL_BROWSERS },
        description: "detect: only these.",
      },
      browser: {
        type: "string",
        enum: MANAGED_BROWSERS,
        description:
          "install or uninstall: the managed binary.",
      },
      all: {
        type: "boolean",
        default: false,
        description: "uninstall: every managed binary.",
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
      return envelope({
        ok: false,
        command: "extension_browsers",
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          message:
            "action 'install' needs a browser: one of chrome, chromium, edge, firefox.",
        },
      });
    }

    return installManagedBrowser(args.browser);
  }

  if (action === "uninstall") {
    return uninstallManagedBrowser({ browser: args.browser, all: args.all });
  }

  return detectBrowsers(args.browsers);
}
