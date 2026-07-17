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
