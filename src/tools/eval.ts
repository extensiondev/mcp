// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily } from "../lib/browser-family";

export const schema = {
  name: "extension_eval",
  description:
    "Evaluate an expression in a running extension context. Requires the dev session to be started with allowEval: true (extension_dev; writes a 0600 session token the CLI reads). Context default: on a Chromium session whose manifest is MV3 (the default template) the default is `page` (the active tab), because the MV3 background is a service worker whose CSP blocks eval, so a background default would fail on the most common path; on Firefox/MV2 sessions the default stays `background`. Pass `context: \"background\"` explicitly to target the worker anyway (on Chromium MV3 that returns the CSP explanation). Targeting for context content/page: pass `url` to pick the matching tab, or omit both `url` and `tab` to use the ACTIVE tab; a numeric `tab` id is only needed to disambiguate. Extension surfaces (popup/options/sidebar/devtools) and override pages (newtab/history/bookmarks) evaluate over the in-bundle relay and need NO tab id; the surface must be OPEN (extension_open first; a closed surface returns an explicit error). Use extension_dom_inspect with listTabs: true to enumerate {tabId,url,title}. Wraps `extension eval`.",
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
        description: "Which extension surface to evaluate in. Default: `background`, EXCEPT on Chromium sessions whose manifest is MV3, where the default is `page` (the active tab) because the MV3 service worker CSP blocks eval; pass `context: \"background\"` explicitly to target the worker anyway.",
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

// Where a defaulted (no `context` arg) eval should land for this session.
// On Chromium the default template's background is an MV3 service worker,
// and Chrome rejects 'unsafe-eval' in MV3 extension contexts, so a
// background default fails on the most common path (swarm C20). Default to
// the page context (active tab) there instead; Firefox and MV2 builds keep
// the background default. Reads the BUILT manifest for the session's browser
// first (the polyglot source manifest can differ per family), falling back
// to the source manifest with `chromium:`-prefixed keys.
export function resolveDefaultEvalContext(
  projectPath: string,
  browser: string,
): "background" | "page" {
  if (!isChromiumFamily(browser)) return "background";
  const candidates = [
    path.join(projectPath, "dist", browser, "manifest.json"),
    path.join(projectPath, "dist", "manifest.json"),
    path.join(projectPath, "src", "manifest.json"),
    path.join(projectPath, "manifest.json"),
  ];
  for (const file of candidates) {
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const version =
      manifest["chromium:manifest_version"] ?? manifest.manifest_version;
    if (version === 3) return "page";
    if (version === 2) return "background";
  }
  return "background";
}

export async function handler(
  args: ActArgs & { expression: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  // Only override the CLI's own background default when we KNOW the session
  // is Chromium MV3; an explicit `context` always wins untouched.
  const defaulted =
    !args.context &&
    resolveDefaultEvalContext(args.projectPath, browser) === "page";
  const context = defaulted ? "page" : args.context;
  const raw = await runActVerb(
    ["eval", args.expression, args.projectPath, ...commonFlags({ ...args, context, browser })],
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
  if (defaulted) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        parsed.defaultedContext = "page";
        parsed.contextNote =
          'No context given: defaulted to "page" (the active tab) because this Chromium session\'s MV3 background is a service worker whose CSP blocks eval. Pass context: "background" explicitly to target the worker (works on Firefox/MV2 builds).';
        // A fresh session's active tab is often the welcome page, which
        // belongs to the manager extension, so a defaulted page eval fails
        // with a "different extension" refusal. Say what to do about it.
        if (
          parsed.ok === false &&
          /cannot access|chrome-extension:\/\/|chrome:\/\//i.test(
            JSON.stringify(parsed.error ?? ""),
          )
        ) {
          parsed.hint =
            "The active tab is a browser or extension page that eval cannot reach. Navigate the dev browser to a regular web page, or pass url (match pattern) or tab to pick one; extension_dom_inspect with listTabs: true lists open tabs.";
        }
        return JSON.stringify(parsed);
      }
    } catch {
      // non-JSON payload; pass through untouched
    }
  }
  return raw;
}
