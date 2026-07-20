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
    "Evaluate an expression in a running extension context. Requires the dev session to be started with allowEval: true (extension_dev; writes a 0600 session token the CLI reads). Targeting for context content/page: pass `url` to pick the matching tab, or omit both `url` and `tab` to use the ACTIVE tab; a numeric `tab` id is only needed to disambiguate. Chromium caveat: eval in the MV3 background/service_worker is blocked by CSP (use an MV2/Firefox build for that context), and context popup has no tab (inspect the open surface with extension_dom_inspect instead). Use extension_dom_inspect with listTabs: true to enumerate {tabId,url,title}. Wraps `extension eval`.",
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
      url: { type: "string", description: "For content/page: selects the target tab by url (match pattern, then substring fallback). Preferred over `tab` — you do not need a numeric id." },
      tab: { type: "number", description: "Numeric chrome.tabs id, for disambiguating when several tabs match. Optional: with neither `tab` nor `url`, content/page target the active tab." },
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
