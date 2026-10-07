// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const CHROMIUM_FAMILY: ReadonlySet<string> = new Set([
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "yandex",
  "chromium-based",
]);

export const GECKO_FAMILY: ReadonlySet<string> = new Set([
  "firefox",
  "waterfox",
  "librewolf",
  "zen",
  "floorp",
  "gecko-based",
  "firefox-based",
]);

export const WEBKIT_FAMILY: ReadonlySet<string> = new Set([
  "safari",
  "webkit-based",
]);

export function isChromiumFamily(browser: string): boolean {
  return CHROMIUM_FAMILY.has(browser);
}

export function isGeckoFamily(browser: string): boolean {
  return GECKO_FAMILY.has(browser);
}

/* @invariant THE ENGINE NAMES ITS OUTPUT DIRECTORY AFTER ITS OWN NORMALISED
   BROWSER NAME: "firefox-based" becomes "gecko-based" (extension-develop, the
   browser name resolver), so every dist and session path built from the
   requested name read nothing for that target. */
export function engineBrowserName(browser: string): string {
  return browser === "firefox-based" ? "gecko-based" : browser;
}
