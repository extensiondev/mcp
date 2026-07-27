// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import { runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_reload",
  description:
    "Reload a running extension's background context, or a tab. Start the session with allowControl:true (extension_dev).",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      context: {
        type: "string",
        enum: ["background", "content", "page"],
        default: "background",
      },
      tab: { type: "number", description: "For content/page: a specific tab id" },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

export async function handler(args: ActArgs): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  return runActVerb(
    ["reload", args.projectPath, ...commonFlags({ ...args, browser })],
    args.projectPath,
    args.timeout,
  );
}
