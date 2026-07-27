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
import fs from "node:fs";
import path from "node:path";
import {
  runActVerb,
  commonFlags,
  actFrameJson,
  addWarning,
  patchValue,
  type ActArgs,
} from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily } from "../lib/browser-family";

export const schema = {
  name: "extension_eval",
  description:
    "Evaluate an expression in a running extension context. Start the session with allowEval:true (extension_dev), which writes a 0600 session token. Context defaults to 'background', except on a Chromium MV3 session (the default template) where it defaults to 'page', the active tab, because the MV3 service worker CSP blocks eval; pass context:'background' to target the worker anyway and get that explanation back. For content and page, pass `url` to pick the tab, or omit both `url` and `tab` for the active tab; a numeric `tab` only disambiguates. Extension surfaces (popup, options, sidebar, devtools) and override pages evaluate over the in-bundle relay and need no tab id, but must already be open: open one with extension_open first, because a closed one returns an explicit error. Call extension_dom_snapshot with listTabs:true to enumerate {tabId, url, title}.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate in the target context",
      },
      context: {
        type: "string",
        enum: ["background", "popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks", "content", "page"],
        description: "Where to evaluate. Default background, except Chromium MV3 sessions default to page (the active tab).",
      },
      url: { type: "string", description: "content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`." },
      tab: { type: "number", description: "Numeric chrome.tabs id, only to disambiguate when several tabs match." },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath", "expression"],
  },
};

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
  const defaulted =
    !args.context &&
    resolveDefaultEvalContext(args.projectPath, browser) === "page";
  const context = defaulted ? "page" : args.context;
  /* @invariant Options before "--", positionals after: the engine's commander
     parser reads a dash-leading expression as an unknown option unless the
     separator precedes it, and treats everything after "--" as operands. */
  const raw = await runActVerb(
    [
      "eval",
      ...commonFlags({ ...args, context, browser }),
      "--",
      args.expression,
      args.projectPath,
    ],
    args.projectPath,
    args.timeout,
    schema.name,
  );

  if (args.context === "content") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.ok === true && (parsed.value === null || parsed.value === undefined)) {
        addWarning(
          parsed,
          "On Extension.js >= 4.0.14 a failed injection errors explicitly, so this null is the expression's real result. On OLDER engines (bug 61) it could mean the injection never ran; if this result looks wrong, check the engine version with extension_doctor, or verify with extension_logs or context:'page'.",
        );
        return actFrameJson(parsed);
      }
    } catch {
      // non-JSON payload; pass through untouched
    }
  }
  if (defaulted) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        patchValue(parsed, { defaultedContext: "page" });
        addWarning(
          parsed,
          'No context given: defaulted to "page" (the active tab) because this Chromium session\'s MV3 background is a service worker whose CSP blocks eval. Pass context: "background" explicitly to target the worker (works on Firefox/MV2 builds).',
        );
        const code =
          typeof parsed.error?.code === "string" ? parsed.error.code : "";
        const unreachable =
          code === "E_TARGET_NOT_FOUND" ||
          // @deprecated Prose fallback until the CLI stamps a code on every eval failure.
          /cannot access|chrome-extension:\/\/|chrome:\/\//i.test(
            JSON.stringify(parsed.error ?? ""),
          );
        if (parsed.ok === false && unreachable) {
          parsed.hint =
            "The active tab is a browser or extension page that eval cannot reach. Navigate the dev browser to a regular web page, or pass url (match pattern) or tab to pick one; extension_dom_snapshot with listTabs: true lists open tabs.";
        }
        return actFrameJson(parsed);
      }
    } catch {
      // non-JSON payload; pass through untouched
    }
  }
  return raw;
}
