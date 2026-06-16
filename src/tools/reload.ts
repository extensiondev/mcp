import { runActVerb, commonFlags, type ActArgs } from "../lib/act";

export const schema = {
  name: "extension_reload",
  description:
    "Reload a running extension (background) or a tab. Requires the dev session to be started with --allow-control. Wraps `extension reload`.",
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
      browser: { type: "string", default: "chromium" },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: ActArgs): Promise<string> {
  return runActVerb(
    ["reload", args.projectPath, ...commonFlags(args)],
    args.projectPath,
    args.timeout,
  );
}
