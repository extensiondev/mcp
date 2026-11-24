// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { WEBKIT_FAMILY } from "./browser-family";
import { envelope } from "./envelope";
import { parseFrameObject } from "./frame-json";

const CSP_EVAL_REFUSAL = /blocked by CSP|call to eval|unsafe-eval|Content Security Policy/i;

export const SAFARI_EVAL_LIMIT =
  "On Safari this tool reaches only page contexts, through the automation window's WebDriver session: the background and the extension surfaces are out of reach (extension_logs reads the background).";

export type SafariPageRoute = "window" | "no-window" | "no-session";

const NEVER_REACHED = new Set(["popup", "options", "sidebar"]);

function refusedByCsp(parsed: Record<string, any>): boolean {
  if (parsed.ok !== false) return false;

  const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
  if (code === "E_CSP_BLOCKS_EVAL") return true;

  return code === "E_EVAL" && CSP_EVAL_REFUSAL.test(String(parsed.error?.message ?? ""));
}

export function safariContextRefusal(
  command: string,
  raw: string,
  browser: string,
  context: string | undefined,
  route: SafariPageRoute = "window",
): string | null {
  if (!WEBKIT_FAMILY.has(browser)) return null;
  if (context === "page" || context === "content") return null;

  const parsed = parseFrameObject(raw);
  if (!parsed || !refusedByCsp(parsed)) return null;

  return safariContextUnreachable(command, browser, context ?? "background", route, true);
}

export function safariContextAskedOutOfReach(
  command: string,
  browser: string | undefined,
  context: string | undefined,
  routeOf: (browser: string) => SafariPageRoute,
): string | null {
  if (!browser || !WEBKIT_FAMILY.has(browser)) return null;
  if (!context || !NEVER_REACHED.has(context)) return null;

  return safariContextUnreachable(command, browser, context, routeOf(browser), false);
}

const PAGE_ROUTE: Record<SafariPageRoute, string> = {
  window:
    'To drive a web page, call extension_open url (the automation window navigates there), then extension_eval context: "page" with that url, which evaluates in the page\'s main world; extension_screenshot captures that window.',
  "no-window":
    'This run has no WebDriver window, so extension_open url, extension_eval context: "page" and extension_screenshot cannot drive a page either; extension_dev with replace: true opens a new one.',
  "no-session":
    'No Safari dev session runs for this project, so start one first: call extension_dev with browser: "safari" and allowEval: true. Its automation window is what extension_open url, extension_eval context: "page" and extension_screenshot drive.',
};

function safariContextUnreachable(command: string, browser: string, where: string, route: SafariPageRoute, engineRefused: boolean): string {
  const why = engineRefused
    ? "the engine tried it and the extension's content_security_policy refused eval there, and Safari offers no inspector path around that policy"
    : "that connection drives web pages only, and Safari offers no inspector path into an extension's own documents";

  return envelope({
    ok: false,
    command,
    status: "safari-context-unreachable",
    error: {
      code: "E_SAFARI_CONTEXT_UNREACHABLE",
      name: "SafariContextUnreachable",
      message: `On Safari, extension_eval reaches only page contexts, through the dev session's WebDriver (safaridriver) connection to its automation window. The ${where} context is out of reach: ${why}, unlike CDP on Chromium and the debugger protocol on Firefox. Engine: webkit.`,
      engine: "webkit",
      retry: "no",
    },
    value: { browser, context: where },
    hint: `${where === "background" ? "For storage, call extension_storage_read or extension_storage_write, which read and write the extension's storage on Safari through code the bridge ships, with no eval. " : ""}Read the ${where} with extension_logs, which reads what the extension writes through the bridge. ${PAGE_ROUTE[route]} A page opened in a regular Safari window is outside the session and cannot be read from here. The popup, options and sidebar documents are not reachable on Safari: run the same project on chrome or firefox to evaluate in them.`,
  });
}
