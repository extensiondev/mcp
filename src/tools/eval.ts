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
import { envelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily, WEBKIT_FAMILY } from "../lib/browser-family";
import {
  readWebDriverSession,
  WebDriverClient,
  type WebDriverSessionInfo,
} from "../lib/webdriver";

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

/* @invariant On Safari the extension's own bridge is the eval channel, the
 * same one every other engine uses: content and background run through the
 * dev session's executor. A safaridriver session, when a dev session has
 * recorded one, adds only the page's main world, so it is used for exactly
 * the explicit "page" context and nothing else is diverted from the bridge.
 */
async function evaluateOnWebKitPage(
  args: ActArgs & { expression: string },
  browser: string,
  info: WebDriverSessionInfo,
): Promise<string> {
  const client = new WebDriverClient(info);
  if (args.url) {
    const current = await client.currentUrl().catch(() => null);
    if (!current || !current.startsWith(args.url)) {
      await client.navigate(args.url);
    }
  }
  try {
    const value = await client.execute(`return (${args.expression});`);
    return envelope({
      ok: true,
      command: schema.name,
      status: "evaluated",
      value: {
        context: "page",
        browser,
        url: await client.currentUrl().catch(() => null),
        result: value,
      },
      hint: "Evaluated in the Safari automation window's main world over the dev session's WebDriver connection.",
    });
  } catch (error) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: {
        code: "E_EVAL",
        name: "EvalError",
        message: error instanceof Error ? error.message : String(error),
      },
      hint: "The expression threw, or the automation window is gone. extension_doctor names which; a session that ended needs extension_dev again.",
    });
  }
}

export async function handler(
  args: ActArgs & { expression: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  if (WEBKIT_FAMILY.has(browser) && args.context === "page") {
    const info = readWebDriverSession(args.projectPath, browser);
    if (info) return evaluateOnWebKitPage(args, browser, info);
  }
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
        /* @invariant The code arm is the right one to read and still is not the
           one that fires. An active tab eval cannot reach is refused by Chrome
           inside chrome.scripting.executeScript, so the guest replies
           EvalError("Cannot access a chrome:// URL") and the CLI maps every
           EvalError to E_EVAL; the engine's E_TARGET_NOT_FOUND is reserved for
           a surface that is not open or a call with no tab id. That is true of
           the engine pinned here, not only of old ones, so this match retires
           when the engine distinguishes an unreachable target from a thrown
           expression, which no version has done yet. What it matches is the
           browser's own refusal and the scheme in the url, neither of which is
           CLI copy. */
        const unreachable =
          code === "E_TARGET_NOT_FOUND" ||
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
