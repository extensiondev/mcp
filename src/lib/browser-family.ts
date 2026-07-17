// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

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
