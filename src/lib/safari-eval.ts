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
): string | null {
  if (!WEBKIT_FAMILY.has(browser)) return null;
  if (context === "page" || context === "content") return null;

  const parsed = parseFrameObject(raw);
  if (!parsed || !refusedByCsp(parsed)) return null;

  const where = context ?? "background";

  return envelope({
    ok: false,
    command,
    status: "safari-context-unreachable",
    error: {
      code: "E_SAFARI_CONTEXT_UNREACHABLE",
      name: "SafariContextUnreachable",
      message: `On Safari, extension_eval reaches only page contexts, through the dev session's WebDriver (safaridriver) connection to its automation window. The ${where} context is out of reach: the extension's content_security_policy (the MV3 default) forbids eval inside the extension's own documents, and Safari offers no inspector path around it, unlike CDP on Chromium and the debugger protocol on Firefox. Engine: webkit.`,
      engine: "webkit",
    },
    value: { browser, context: where },
    hint: `Read the ${where} with extension_logs, which reads what the extension writes through the bridge. To drive a web page, call extension_open url (the automation window navigates there), then extension_eval context: "page" with that url, which evaluates in the page's main world; extension_screenshot captures that window. A page opened in a regular Safari window is outside the session and cannot be read from here. The popup, options and sidebar documents are not reachable on Safari: run the same project on chrome or firefox to evaluate in them.`,
  });
}
