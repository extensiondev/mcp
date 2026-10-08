// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { surfaceDocument } from "../tools/open";

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
