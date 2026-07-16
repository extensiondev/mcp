import { runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_reload",
  description:
    "Reload a running extension (background) or a tab. Requires the dev session to be started with allowControl: true (extension_dev). Wraps `extension reload`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      context: {
        type: "string",
        enum: ["background", "content", "page"],
        default: "background",
      },
      tab: { type: "number", description: "For content/page: a specific tab id" },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
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
