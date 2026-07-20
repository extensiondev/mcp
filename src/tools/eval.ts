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
    "Evaluate an expression in a running extension context. Requires the dev session to be started with allowEval: true (extension_dev; writes a 0600 session token the CLI reads). Targeting for context content/page: pass `url` to pick the matching tab, or omit both `url` and `tab` to use the ACTIVE tab; a numeric `tab` id is only needed to disambiguate. Extension surfaces (popup/options/sidebar/devtools) and override pages (newtab/history/bookmarks) evaluate over the in-bundle relay and need NO tab id; the surface must be OPEN (extension_open first; a closed surface returns an explicit error). Chromium caveat: eval in the MV3 background/service_worker is blocked by CSP (use an MV2/Firefox build for that context). Use extension_dom_inspect with listTabs: true to enumerate {tabId,url,title}. Wraps `extension eval`.",
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
        enum: ["background", "popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks", "content", "page"],
        default: "background",
        description: "Which extension surface to evaluate in",
      },
      url: { type: "string", description: "For content/page: selects the target tab by url (match pattern, then substring fallback). Preferred over `tab`. You do not need a numeric id." },
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
  const raw = await runActVerb(
    ["eval", args.expression, args.projectPath, ...commonFlags({ ...args, browser })],
    args.projectPath,
    args.timeout,
  );

  // Engines carrying the bug-61 fix (Extension.js >= 4.0.14) reply with an
  // explicit error when the isolated-world injection never runs, so an ok:true
  // null from them is a REAL null. Engines older than that could lie
  // (injection dead, ok:true value:null); keep a soft note for the ambiguous
  // case only, so an old engine cannot make the MCP complicit without
  // condemning content eval on engines where it works.
  if (args.context === "content") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.ok === true && (parsed.value === null || parsed.value === undefined)) {
        parsed.note =
          "On Extension.js >= 4.0.14 a failed injection errors explicitly, so this null is the expression's real result. On OLDER engines (bug 61) it could mean the injection never ran; if this result looks wrong, check the engine version with extension_doctor, or verify with extension_logs or context:'page'.";
        return JSON.stringify(parsed);
      }
    } catch {
      // non-JSON payload; pass through untouched
    }
  }
  return raw;
}
