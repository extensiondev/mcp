// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const REFUSED_INJECTION =
  /missing host permission|cannot access contents|cannot be scripted|cannot access a chrome|extensions gallery/i;

const EXTENSION_PAGE = /\b(?:moz|chrome|safari-web|ms-browser)-extension:\/\//i;

const RELATIVE_DOCUMENT = /^(?![a-z][a-z0-9+.-]*:)(?!\*)[^\s]*\.html?(?:[?#].*)?$/i;

export interface InjectionTarget {
  browser?: string;
  url?: string;
}

function refusedInjection(error: Record<string, unknown> | null | undefined): boolean {
  if (!error || error.code !== "E_COMMAND_UNSUPPORTED_FOR_TARGET") return false;

  return error.name === "InjectionRefused" || REFUSED_INJECTION.test(String(error.message ?? ""));
}

function namesExtensionPage(url: string | undefined, message: string): boolean {
  if (typeof url === "string" && (EXTENSION_PAGE.test(url) || RELATIVE_DOCUMENT.test(url.trim()))) return true;

  return EXTENSION_PAGE.test(message);
}

export function nameRefusedInjection(frame: any, target: InjectionTarget): void {
  if (!frame || frame.ok !== false || !refusedInjection(frame.error)) return;

  const browser = target.browser ?? "the browser";
  const message = String(frame.error.message ?? "");

  frame.error.cliCode = frame.error.code;

  if (namesExtensionPage(target.url, message)) {
    frame.status = "extension-page-unreachable";
    frame.error.code = "E_EXTENSION_PAGE_UNREACHABLE";
    frame.hint = `The tab is open, but ${browser} refuses script injection into the extension's own pages, so nothing ran there. Reach the page through its surface instead: context: "options", "popup", "sidebar" or "newtab" on an extension_dev session, whose pages carry the relay; extension_dom_snapshot with the same context reads its DOM.`;

    return;
  }

  frame.status = "page-not-scriptable";
  frame.error.code = "E_PAGE_NOT_SCRIPTABLE";
  frame.hint = `The tab is open, but ${browser} refused to script it, so nothing ran there. A browser page (chrome://, about:, the extension store) is never scriptable; a web page needs the extension to hold host access to it, through host_permissions (or activeTab after a click on the extension). If the tab shows one of the extension's own pages, which injection never enters either, use its surface context instead (context: "options", "popup", "sidebar" or "newtab"). Otherwise pick a page the extension may script (extension_dom_snapshot with listTabs: true lists the open tabs), or add the origin to host_permissions and let the dev server rebuild.`;
}
