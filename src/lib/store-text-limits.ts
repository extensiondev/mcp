// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type StoreTextLimitStore = "chrome" | "edge" | "firefox" | "safari";

export type StoreTextLimitField =
  | "title"
  | "appStoreName"
  | "subtitle"
  | "shortDescription"
  | "fullDescription"
  | "homepageUrl"
  | "supportUrl"
  | "supportEmail"
  | "releaseNotes"
  | "reviewerNotes";

export type StoreTextUnit = "characters" | "bytes";

export type StoreTextLimit = {
  max: number;
  unit: StoreTextUnit;
  label: string;
  source: string;
};

export type StoreTextOverLimit = {
  store: StoreTextLimitStore;
  field: StoreTextLimitField;
  label: string;
  length: number;
  max: number;
  unit: StoreTextUnit;
};

const CHROME_NAME = "https://developer.chrome.com/docs/extensions/reference/manifest/name";
const CHROME_DESCRIPTION =
  "https://developer.chrome.com/docs/extensions/reference/manifest/description";
const CHROME_LISTING = "https://developer.chrome.com/docs/webstore/cws-dashboard-listing";
const EDGE_PUBLISH =
  "https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension";
const MDN_NAME =
  "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/name";
const AMO_LISTING =
  "https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/";
const AMO_ADDON_MODEL =
  "https://github.com/mozilla/addons-server/blob/master/src/olympia/addons/models.py";
const AMO_VERSION_MODEL =
  "https://github.com/mozilla/addons-server/blob/master/src/olympia/versions/models.py";
const APPLE_APP_INFORMATION =
  "https://developer.apple.com/help/app-store-connect/reference/app-information/app-information";
const APPLE_VERSION_INFORMATION =
  "https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information";

const chars = (max: number, label: string, source: string): StoreTextLimit => ({
  max,
  unit: "characters",
  label,
  source,
});

/* @invariant
 * ONE TABLE SAYS HOW LONG A VALUE MAY BE WHEN IT LEAVES FOR A STORE, AND
 * WWW, THE CONSOLE AND THE MCP ALL READ THE SAME NUMBERS. THIS IS THE MCP'S
 * COPY OF @extensiondev/ui store-text-limits.
 *
 * www refuses a listing write whose field is over its store's number here
 * (LISTING_FIELD_OVER_LIMIT) and its store requirement rows block review on
 * the same numbers, so no door, console, MCP or a bare token, can record a
 * value the store would refuse or cut. The public MCP keeps its own copy and
 * the monorepo's ui spec store-text-limits.mcp-copy.spec.ts reads both.
 *
 * WHERE EACH NUMBER COMES FROM is the row's source. Most are stated by the
 * store. Four are not, and are kept on the owner's word until a store prints
 * one: Chrome's 16,000 description (Google prints none, ruled 2026-11-04),
 * Edge's 45 name (MDN's, Microsoft prints none), Edge's 250 short
 * description (Microsoft prints none), and AMO's 15,000 description and its
 * 255, 100 and 3,000 field caps, which are addons-server's own model limits
 * because AMO's docs print none. Apple counts keywords and review notes in
 * bytes, so those two rows measure UTF-8 bytes; every other row counts
 * characters as www always has, the trimmed text's length.
 */
export const STORE_TEXT_LIMITS: Record<
  StoreTextLimitStore,
  Partial<Record<StoreTextLimitField, StoreTextLimit>>
> = {
  chrome: {
    title: chars(75, "Name", CHROME_NAME),
    shortDescription: chars(132, "Summary", CHROME_DESCRIPTION),
    fullDescription: chars(16_000, "Description", CHROME_LISTING),
  },
  edge: {
    title: chars(45, "Name", MDN_NAME),
    shortDescription: chars(250, "Short description", EDGE_PUBLISH),
    fullDescription: chars(10_000, "Description", EDGE_PUBLISH),
  },
  firefox: {
    title: chars(50, "Name", AMO_ADDON_MODEL),
    shortDescription: chars(250, "Summary", AMO_LISTING),
    fullDescription: chars(15_000, "Description", AMO_ADDON_MODEL),
    homepageUrl: chars(255, "Homepage", AMO_ADDON_MODEL),
    supportUrl: chars(255, "Support site", AMO_ADDON_MODEL),
    supportEmail: chars(100, "Support email", AMO_ADDON_MODEL),
    releaseNotes: chars(3_000, "Release notes", AMO_VERSION_MODEL),
    reviewerNotes: chars(3_000, "Notes to reviewer", AMO_VERSION_MODEL),
  },
  safari: {
    appStoreName: chars(30, "Name", APPLE_APP_INFORMATION),
    subtitle: chars(30, "Subtitle", APPLE_APP_INFORMATION),
    fullDescription: chars(4_000, "Description", APPLE_VERSION_INFORMATION),
    releaseNotes: chars(4_000, "What's New", APPLE_VERSION_INFORMATION),
    reviewerNotes: { max: 4_000, unit: "bytes", label: "App Review notes", source: APPLE_VERSION_INFORMATION },
  },
};

export const STORE_LABELS: Record<StoreTextLimitStore, string> = {
  chrome: "the Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox Add-ons",
  safari: "the App Store",
};

export const EDGE_SEARCH_TERMS = { items: 7, each: 30, words: 21, source: EDGE_PUBLISH } as const;

export const SAFARI_KEYWORDS = { bytes: 100, eachMoreThan: 2, source: APPLE_VERSION_INFORMATION } as const;

export const STORE_SCREENSHOTS_MAX: Partial<Record<StoreTextLimitStore, number>> = {
  chrome: 5,
  edge: 6,
  safari: 10,
};

export function measureStoreText(text: string, unit: StoreTextUnit): number {
  return unit === "bytes" ? new TextEncoder().encode(text).length : text.length;
}

export function storeTextLimit(
  store: string,
  field: string,
): StoreTextLimit | undefined {
  const limits = STORE_TEXT_LIMITS[store as StoreTextLimitStore];

  return limits ? limits[field as StoreTextLimitField] : undefined;
}

export function storeTextOverLimit(
  store: string,
  field: string,
  value: unknown,
): StoreTextOverLimit | null {
  const limit = storeTextLimit(store, field);
  if (!limit || typeof value !== "string") return null;

  const length = measureStoreText(value.trim(), limit.unit);
  if (length <= limit.max) return null;

  return {
    store: store as StoreTextLimitStore,
    field: field as StoreTextLimitField,
    label: limit.label,
    length,
    max: limit.max,
    unit: limit.unit,
  };
}

export function storeTextOverLimitSentence(over: StoreTextOverLimit): string {
  const count = (n: number) => n.toLocaleString("en-US");

  return `listing.${over.field} (${over.label}) is ${count(over.length)} ${over.unit}, over the ${count(over.max)} ${over.unit} ${STORE_LABELS[over.store]} takes, so nothing was written`;
}

export function safariKeywordsProblem(terms: readonly string[]): string | null {
  const short = terms.find((term) => term.length <= SAFARI_KEYWORDS.eachMoreThan);

  if (short !== undefined) {
    return `listing.searchTerms holds "${short}", and the App Store takes only keywords longer than ${SAFARI_KEYWORDS.eachMoreThan} characters, so nothing was written`;
  }

  const bytes = measureStoreText(terms.join(","), "bytes");

  if (bytes > SAFARI_KEYWORDS.bytes) {
    return `listing.searchTerms is ${bytes} bytes joined by commas, over the ${SAFARI_KEYWORDS.bytes} bytes the App Store keywords take, so nothing was written`;
  }

  return null;
}

export function edgeSearchTermsProblem(terms: readonly string[]): string | null {
  if (terms.length > EDGE_SEARCH_TERMS.items) {
    return `listing.searchTerms holds ${terms.length} terms, over the ${EDGE_SEARCH_TERMS.items} Edge Add-ons takes, so nothing was written`;
  }

  const long = terms.find((term) => term.length > EDGE_SEARCH_TERMS.each);

  if (long !== undefined) {
    return `listing.searchTerms holds "${long}", ${long.length} characters, over the ${EDGE_SEARCH_TERMS.each} Edge Add-ons takes for one term, so nothing was written`;
  }

  const words = terms.reduce((total, term) => total + term.split(/\s+/).filter(Boolean).length, 0);

  if (words > EDGE_SEARCH_TERMS.words) {
    return `listing.searchTerms holds ${words} words, over the ${EDGE_SEARCH_TERMS.words} Edge Add-ons takes across all terms, so nothing was written`;
  }

  return null;
}

export function storeSearchTermsProblem(store: string, terms: readonly string[]): string | null {
  if (store === "safari") return safariKeywordsProblem(terms);
  if (store === "edge") return edgeSearchTermsProblem(terms);

  return null;
}
