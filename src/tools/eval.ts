import { runActVerb, commonFlags, type ActArgs } from "../lib/act";

export const schema = {
  name: "extension_eval",
  description:
    "Evaluate an expression in a running extension context (service worker, content script, popup, options, sidebar). Requires the dev session to be started with --allow-eval (writes a 0600 session token the CLI reads). Wraps `extension eval`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate in the target context",
      },
      context: {
        type: "string",
        enum: ["background", "popup", "options", "sidebar", "devtools", "content", "page"],
        default: "background",
        description: "Which extension surface to evaluate in",
      },
      url: { type: "string", description: "For content/page: document(s) to target" },
      tab: { type: "number", description: "For content/page: a specific tab id" },
      browser: { type: "string", default: "chromium" },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath", "expression"],
  },
};

export async function handler(
  args: ActArgs & { expression: string },
): Promise<string> {
  return runActVerb(
    ["eval", args.expression, args.projectPath, ...commonFlags(args)],
    args.projectPath,
    args.timeout,
  );
}
