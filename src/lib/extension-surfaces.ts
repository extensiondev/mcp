// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { surfaceDocument } from "../tools/open";
import { envelope } from "./envelope";
import { readyContractPath } from "./session-paths";
import { geckoRecency } from "./target-pick";

export const EXTENSION_PAGE_CONTEXTS = [
  "popup",
  "options",
  "sidebar",
  "devtools",
  "newtab",
  "history",
  "bookmarks",
];

export const EXTENSION_ORIGIN = /^(moz|chrome|safari-web)-extension:\/\//;

export function isExtensionUrl(url: string | undefined): boolean {
  return typeof url === "string" && EXTENSION_ORIGIN.test(url);
}

export function surfaceForExtensionUrl(
  projectPath: string,
  browser: string,
  url: string,
): { context: string; document: string } | null {
  const bare = url
    .replace(EXTENSION_ORIGIN, "")
    .replace(/^[^/]*\//, (m) => (EXTENSION_ORIGIN.test(url) ? "" : m))
    .replace(/^\.?\//, "")
    .replace(/[?#].*$/, "");
  if (!bare) return null;

  for (const context of EXTENSION_PAGE_CONTEXTS) {
    const document = surfaceDocument(projectPath, browser, context);
    if (!document) continue;

    if (
      bare === document ||
      bare.endsWith(`/${document}`) ||
      document.endsWith(`/${bare}`)
    ) {
      return { context, document };
    }
  }

  return null;
}

export function geckoDocumentTab<T extends { url?: string }>(
  tabs: T[],
  document: string,
): T | undefined {
  const wanted = document.replace(/^\.?\//, "").replace(/[?#].*$/, "");

  return tabs.find((tab) => {
    const match = /^moz-extension:\/\/[^/]+\/([^?#]*)/.exec(String(tab.url ?? ""));

    return match !== null && match[1] === wanted;
  });
}

export function urlKey(url: string, wanted: string): string {
  return wanted.includes("#") ? url : url.replace(/[?#].*$/, "");
}

export function geckoExtensionTabsByUrl<T extends { url?: string }>(tabs: T[], url: string): T[] {
  const wanted = urlKey(url, url);
  const own = tabs.filter((tab) => /^moz-extension:\/\//.test(String(tab.url ?? "")));
  const exact = own.filter((tab) => urlKey(String(tab.url ?? ""), url) === wanted);

  return exact.length ? exact : own.filter((tab) => String(tab.url ?? "").includes(wanted));
}

export function geckoExtensionTabByUrl<T extends { url?: string; selected?: boolean; browserId?: number }>(
  tabs: T[],
  url: string,
): T | undefined {
  const candidates = geckoExtensionTabsByUrl(tabs, url);

  return [...candidates].sort(geckoRecency)[0];
}

export function distinctUrls(items: Array<{ url?: string }>): string[] {
  return [...new Set(items.map((item) => String(item.url ?? "")))];
}

export function productionSessionCommand(
  projectPath: string,
  browser: string,
): "start" | "preview" | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8"));
    const command = contract?.command;

    return command === "start" || command === "preview" ? command : null;
  } catch {
    return null;
  }
}

export function extensionPageUnreachable(
  tool: string,
  browser: string,
  sessionCommand: "start" | "preview",
  target: string,
  reason: "no-debug-port" | "no-tab" = "no-debug-port",
): string {
  const why =
    reason === "no-debug-port"
      ? "and this session's contract records no debugger (RDP) port to read a tab over. This says nothing about whether the page is open."
      : "so only a page shown in a tab is reached, over the debugger protocol, and no tab shows it now. If it is open in its own window (a popup), that window is not reachable here.";

  return envelope({
    ok: false,
    command: tool,
    status: "extension-page-unreachable",
    error: {
      code: "E_EXTENSION_PAGE_UNREACHABLE",
      name: "ExtensionPageUnreachable",
      message: `Cannot reach extension pages on a ${browser} start session through the bridge: ${target} is a page inside the extension, the production build carries the control producer in its background only, so no page relay answers there, and script injection cannot enter a moz-extension:// document; ${why}`,
    },
    hint:
      reason === "no-debug-port"
        ? `Use extension_dev with browser: "${browser}" to read or evaluate the extension's own pages; web pages and the background still answer on this session.`
        : `Open the page in a tab (extension_open with its url) and retry, or use extension_dev with browser: "${browser}", whose pages carry the relay.`,
  });
}

export function namesExtensionDocument(
  projectPath: string,
  browser: string,
  url: string,
): boolean {
  if (isExtensionUrl(url)) return true;

  const bare = url.replace(/^\.?\//, "").replace(/[?#].*$/, "");

  return surfaceForExtensionUrl(projectPath, browser, url)?.document === bare;
}

export function mayNameExtensionTab(url: string): boolean {
  return isExtensionUrl(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url);
}
