// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { filterKeysForThisBrowser } from "extension-develop/manifest";

/* @invariant THE VALIDATOR'S VIEW OF A MANIFEST IS THE ENGINE'S. This is the
   engine's own filter, exported from extension-develop/manifest. */
export function engineManifestView(
  manifest: Record<string, unknown>,
  browser: string,
): Record<string, unknown> {
  return filterKeysForThisBrowser(
    manifest as Parameters<typeof filterKeysForThisBrowser>[0],
    browser as Parameters<typeof filterKeysForThisBrowser>[1],
  ) as Record<string, unknown>;
}
