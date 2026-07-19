// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_eval",
  description:
    "Evaluate an expression in a running extension context. Requires the dev session to be started with allowEval: true (extension_dev; writes a 0600 session token the CLI reads). Chromium caveats: eval in the MV3 background/service_worker is blocked by CSP (use an MV2/Firefox build for that context), and context content/page/popup require a numeric `tab` id (a chrome.tabs id) — the `url` arg alone does not target a tab. To read a content-script DOM without a tab id, prefer extension_source_inspect (it auto-selects the active page and can navigate by url). Wraps `extension eval`.",
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
      url: { type: "string", description: "For content/page: filters which matching document(s) to target, but does NOT by itself select a tab — a numeric `tab` id is still required on Chromium." },
      tab: { type: "number", description: "Numeric chrome.tabs id. Required for context content/page/popup on Chromium (the `url` arg does not substitute for it)." },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath", "expression"],
  },
};

export async function handler(
  args: ActArgs & { expression: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  return runActVerb(
    ["eval", args.expression, args.projectPath, ...commonFlags({ ...args, browser })],
    args.projectPath,
    args.timeout,
  );
}
