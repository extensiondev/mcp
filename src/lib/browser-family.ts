/**
 * Browser-family classification, shared by every tool that branches on the
 * target engine. Keep this the ONLY copy: a field report showed the inline
 * lists drifting — `--browser chromium` (a first-class Extension.js target
 * and the act tools' historical default) was refused by tools whose local
 * list only knew "chrome"/"edge".
 */
export const CHROMIUM_FAMILY: ReadonlySet<string> = new Set([
  "chrome",
  "chromium",
  "edge",
  "chromium-based",
]);

export const GECKO_FAMILY: ReadonlySet<string> = new Set([
  "firefox",
  "gecko-based",
  "firefox-based",
]);

export function isChromiumFamily(browser: string): boolean {
  return CHROMIUM_FAMILY.has(browser);
}

export function isGeckoFamily(browser: string): boolean {
  return GECKO_FAMILY.has(browser);
}
