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
  "newtab",
  "history",
  "bookmarks",
];

export const EXTENSION_ORIGIN = /^(moz|chrome|safari-web)-extension:\/\//;

export function isExtensionUrl(url: string | undefined): boolean {
  return typeof url === "string" && EXTENSION_ORIGIN.test(url);
}

/* @invariant A url inside the extension names one of its own documents, and
   the only way to reach such a document on every engine is the surface
   relay for the context that document belongs to: script injection never
   reaches an extension page, on Chromium or on Gecko. So a url is mapped to
   a declared surface here, by the full extension address, by the document
   path the manifest declares, or by that document's file name, and the
   caller asks that context instead of a tab. */
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
