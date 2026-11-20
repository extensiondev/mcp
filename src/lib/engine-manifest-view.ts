// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const CHROMIUM_BASED_BROWSERS = ["chrome", "edge", "brave", "opera", "vivaldi", "yandex"];
const GECKO_BASED_BROWSERS = ["firefox", "waterfox", "librewolf", "zen", "floorp"];
const CHROMIUM_FAMILY_PREFIXES = new Set(["chromium"]);
const GECKO_FAMILY_PREFIXES = new Set(["gecko", "firefox"]);
const WEBKIT_PREFIXES = new Set(["safari", "webkit"]);

function prefixRanks(browser: string) {
  const webkit = browser === "safari" || browser.includes("webkit");
  const chromium = CHROMIUM_BASED_BROWSERS.includes(browser) || browser.includes("chromium") || webkit;
  const gecko = GECKO_BASED_BROWSERS.includes(browser) || browser.includes("gecko") || browser.includes("firefox");

  return {
    family: (prefix: string) =>
      (chromium && CHROMIUM_FAMILY_PREFIXES.has(prefix)) || (gecko && GECKO_FAMILY_PREFIXES.has(prefix)),
    specific: (prefix: string) => prefix === browser || (webkit && WEBKIT_PREFIXES.has(prefix)),
  };
}

/* @invariant THE PER-BROWSER VIEW IS THE ENGINE'S filterKeysForThisBrowser,
 * COPIED. Extension.js 4.2.0 marks its extension-develop/manifest entry as
 * removed in the next minor and publishes the function nowhere else, so the
 * rule lives here: a plain key loses to a family prefix (chromium:, or
 * gecko: and firefox:), which loses to the browser's own name (and safari:
 * and webkit: on a WebKit target); a key under any other prefix is dropped.
 * browser-family.test.ts holds this copy to the engine's answer. */
export function engineManifestView(
  manifest: Record<string, unknown>,
  browser: string,
): Record<string, unknown> {
  const ranks = prefixRanks(String(browser));

  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolve(item));
    if (!node || typeof node !== "object") return node;

    const plain = new Map<string, unknown>();
    const family = new Map<string, unknown>();
    const specific = new Map<string, unknown>();

    for (const [key, value] of Object.entries(node)) {
      const colon = key.indexOf(":");

      if (colon === -1) {
        plain.set(key, resolve(value));
        continue;
      }

      const prefix = key.substring(0, colon);
      const stripped = key.substring(colon + 1);

      if (ranks.specific(prefix)) specific.set(stripped, resolve(value));
      else if (ranks.family(prefix)) family.set(stripped, resolve(value));
    }

    for (const [key, value] of family) plain.set(key, value);
    for (const [key, value] of specific) plain.set(key, value);

    return Object.fromEntries(plain);
  };

  return resolve(manifest) as Record<string, unknown>;
}
