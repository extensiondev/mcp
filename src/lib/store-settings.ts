// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { AMO_API_KEY_PAGE } from "./firefox-store";
import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

export const STORE_SETTINGS_ACTION = "extension_settings.store";

export const STORE_SETTINGS_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type StoreSettingsStore = (typeof STORE_SETTINGS_STORES)[number];

export const SUBMISSION_MODE_IDS: Record<StoreSettingsStore, readonly string[]> = {
  chrome: ["draft-until-public", "draft", "public", "staged", "dry-run"],
  edge: ["draft", "review", "dry-run"],
  firefox: ["unlisted", "listed", "dry-run"],
  safari: ["draft", "dry-run"],
};

export const STORE_SETTING_KEYS = ["enabled", "submissionMode", "sourceArchive", "releaseChannel", "chromeItemId", "edgeProductId", "firefoxAddonGuid", "appStoreId", "bundleId"] as const;

const FIREFOX_ONLY_KEYS = new Set(["sourceArchive", "releaseChannel"]);

export const ID_KEYS: Record<string, StoreSettingsStore> = { chromeItemId: "chrome", edgeProductId: "edge", firefoxAddonGuid: "firefox", appStoreId: "safari" };

const CHROME_ITEM_ID = /^[a-p]{32}$/i;
const CHROME_DASHBOARD_ADDRESS = /devconsole\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[^/\s]+)\/([a-p]{32})(?:[/?#]|$)/i;
const EDGE_PRODUCT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMO_GUID = /^(?:\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9._-]*@[a-z0-9._-]+)$/i;
const APP_STORE_ID = /^[1-9]\d{5,14}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const AMO_GUID_RULING = "An AMO slug or numeric id does not identify the add-on to Mozilla's blocklist.";

const CONSOLE_ONLY_KEYS = new Set([
  "storeId",
  "storeUrl",
  "publisherId",
  "appAppleId",
  "deployPercentage",
  "reviewExemption",
  "versionSource",
  "dryRun",
  "skipPublish",
  "stagedPublish",
  "publishAfter",
]);

const CREDENTIAL_KEY = /secret|token|password|credential|issuer|key|client|json|p8|pem|cert|account|oauth|refresh/i;

export const PATCH_KEYS = ["enabled", "dryRun", "skipPublish", "stagedPublish", "publishAfter", "releaseChannel", "sourceArchive", "storeId", "bundleId"] as const;

export type StoreSettingsPatch = Partial<Record<(typeof PATCH_KEYS)[number], boolean | string | null>>;

export const CREDENTIAL_LABELS: Record<StoreSettingsStore, string> = {
  chrome: "the Chrome Web Store connection (Connect Chrome Web Store; Google asks for one click)",
  firefox: `the JWT issuer and the JWT secret, as the console form labels them, issued once at ${AMO_API_KEY_PAGE}`,
  edge: "the Publish API Client ID, the Publish API key and the Product ID (GUID) from Partner Center, as the console form labels them",
  safari: "the App Store Connect issuer ID, the App Store Connect key ID and the App Store Connect private key (.p8), as the console form labels them",
};

export function isStoreSettingsStore(value: string): value is StoreSettingsStore {
  return (STORE_SETTINGS_STORES as readonly string[]).includes(value);
}

/* @invariant A MODE ID IS WRITTEN AS THE FIELDS THE PLATFORM READS IT FROM.
 * The platform derives a store's submission mode from saved booleans (Chrome
 * dryRun, skipPublish and stagedPublish; Edge publishAfter; Firefox
 * releaseChannel), in a fixed order of precedence, and never stores the mode
 * id itself. Each id here writes every field that order consults, so the id
 * the preflight answers afterwards is the id that was asked for and no
 * leftover boolean from an earlier mode changes the reading.
 */
export function modeToPatch(store: StoreSettingsStore, mode: string): StoreSettingsPatch {
  if (mode === "dry-run") return { dryRun: true };

  if (store === "chrome") {
    if (mode === "draft") return { dryRun: false, skipPublish: true, stagedPublish: false };
    if (mode === "public") return { dryRun: false, skipPublish: false, stagedPublish: false };
    if (mode === "staged") return { dryRun: false, skipPublish: null, stagedPublish: true };

    return { dryRun: false, skipPublish: null, stagedPublish: false };
  }

  if (store === "edge") return { dryRun: false, publishAfter: mode === "review" };
  if (store === "firefox") return { dryRun: false, releaseChannel: mode };

  return { dryRun: false };
}

export type StoreSettingsRead =
  | { patch: StoreSettingsPatch; requested: Row }
  | { problem: string }
  | { credential: string[] };

export function readStoreSettingsChange(store: StoreSettingsStore, raw: unknown): StoreSettingsRead {
  if (!isRow(raw) || Object.keys(raw).length === 0) {
    return { problem: `storeSettings must name at least one of ${STORE_SETTING_KEYS.join(", ")}, such as { "enabled": true }.` };
  }

  const credential = Object.keys(raw).filter((key) => !(STORE_SETTING_KEYS as readonly string[]).includes(key) && CREDENTIAL_KEY.test(key));
  if (credential.length) return { credential };

  const consoleOnly = Object.keys(raw).filter((key) => CONSOLE_ONLY_KEYS.has(key));

  if (consoleOnly.length) {
    return {
      problem: `storeSettings has ${consoleOnly.map((k) => `"${k}"`).join(", ")}, which is a raw platform field; a listing id goes in as chromeItemId, edgeProductId, firefoxAddonGuid or appStoreId, the Safari bundle id as bundleId, and publisher ids, store URLs and the rest stay a person at a keyboard in the console store settings. Use ${STORE_SETTING_KEYS.join(", ")}.`,
    };
  }

  const unknown = Object.keys(raw).filter((key) => !(STORE_SETTING_KEYS as readonly string[]).includes(key));

  if (unknown.length) {
    return { problem: `storeSettings has ${unknown.map((k) => `"${k}"`).join(", ")}, which is not a store setting; use ${STORE_SETTING_KEYS.join(", ")}.` };
  }

  const firefoxOnly = Object.keys(raw).filter((key) => FIREFOX_ONLY_KEYS.has(key));

  if (store !== "firefox" && firefoxOnly.length) {
    return { problem: `${firefoxOnly.map((k) => `"${k}"`).join(", ")} is a Firefox store setting; ${store} does not have it.` };
  }

  if (store !== "safari" && "bundleId" in raw) {
    return { problem: `"bundleId" is a safari store setting; ${store} does not have it.` };
  }

  const foreignId = Object.keys(raw).filter((key) => key in ID_KEYS && ID_KEYS[key] !== store);

  if (foreignId.length) {
    return { problem: `${foreignId.map((k) => `"${k}"`).join(", ")} is a ${ID_KEYS[foreignId[0]!]} store setting; ${store} does not have it.` };
  }

  const patch: StoreSettingsPatch = {};
  const requested: Row = {};
  const id = readStoreId(store, raw);

  if (id && "problem" in id) return id;

  if (id) {
    patch.storeId = id.storeId;
    requested[id.key] = id.storeId;
  }

  if ("bundleId" in raw) {
    const bundleId = text(raw.bundleId);

    if (!BUNDLE_ID.test(bundleId)) {
      return { problem: `bundleId must be a reverse-DNS identifier with two or more labels of letters, digits and hyphens, under a domain your Apple team controls, such as com.yourcompany.yourextension; got "${bundleId}".` };
    }

    patch.bundleId = bundleId;
    requested.bundleId = bundleId;
  }

  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") return { problem: "storeSettings.enabled must be true or false." };

    patch.enabled = raw.enabled;
    requested.enabled = raw.enabled;
  }

  const mode = "submissionMode" in raw ? text(raw.submissionMode).toLowerCase() : "";

  if ("submissionMode" in raw) {
    if (!SUBMISSION_MODE_IDS[store].includes(mode)) {
      return { problem: `storeSettings.submissionMode for ${store} must be one of ${SUBMISSION_MODE_IDS[store].join(", ")}; got "${text(raw.submissionMode)}".` };
    }

    Object.assign(patch, modeToPatch(store, mode));
    requested.submissionMode = mode;
  }

  if ("releaseChannel" in raw) {
    const channel = text(raw.releaseChannel).toLowerCase();

    if (channel !== "listed" && channel !== "unlisted") {
      return { problem: `storeSettings.releaseChannel must be listed or unlisted; got "${text(raw.releaseChannel)}".` };
    }

    if (mode && mode !== "dry-run" && mode !== channel) {
      return { problem: `storeSettings.releaseChannel "${channel}" and submissionMode "${mode}" name different Firefox channels; pass one of them.` };
    }

    patch.releaseChannel = channel;
    requested.releaseChannel = channel;
  }

  if ("sourceArchive" in raw) {
    const archive = text(raw.sourceArchive).toLowerCase();

    if (archive !== "repository" && archive !== "none") {
      return { problem: `storeSettings.sourceArchive must be repository or none; got "${text(raw.sourceArchive)}".` };
    }

    patch.sourceArchive = archive;
    requested.sourceArchive = archive;
  }

  return { patch, requested };
}

/* @invariant A LISTING ID IS CHECKED IN THE STORE'S OWN TERMS BEFORE IT IS
 * SENT, AND A FIREFOX SLUG IS REFUSED BY RULING. Chrome takes the 32-letter
 * item id or the dashboard address the console's own field parses it from;
 * Edge takes the Product ID GUID Partner Center shows; Firefox takes only an
 * add-on GUID (name@example.com or {uuid}), never an AMO slug or numeric id,
 * which does not identify the add-on to Mozilla's blocklist; Safari takes the
 * app record's numeric App Store id (ledger 159). Each goes to the platform
 * as that store's storeId, a plain write under an owner's token, beside the
 * Safari bundleId, the project's own identifier (ledger 155); publisher ids
 * and store URLs stay in the console.
 */
function readStoreId(store: StoreSettingsStore, raw: Row): { key: string; storeId: string } | { problem: string } | null {
  const key = Object.keys(ID_KEYS).find((name) => name in raw && ID_KEYS[name] === store);
  if (!key) return null;

  const value = text(raw[key]);

  if (store === "chrome") {
    const bare = CHROME_ITEM_ID.test(value) ? value : CHROME_DASHBOARD_ADDRESS.exec(value)?.[1] ?? "";

    return bare
      ? { key, storeId: bare.toLowerCase() }
      : { problem: `chromeItemId must be the item's 32-letter id, or the item's address from the Chrome Web Store developer dashboard (chrome.google.com/webstore/devconsole/<publisher>/<item>); got "${value}".` };
  }

  if (store === "edge") {
    return EDGE_PRODUCT_ID.test(value)
      ? { key, storeId: value.toLowerCase() }
      : { problem: `edgeProductId must be the Product ID GUID from Partner Center (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx); got "${value}".` };
  }

  if (store === "safari") {
    return APP_STORE_ID.test(value)
      ? { key, storeId: value }
      : { problem: `appStoreId must be the App Store id of the app record: the 6 to 15 digit Apple ID shown under App Information in App Store Connect; got "${value}".` };
  }

  return value.length <= 255 && AMO_GUID.test(value)
    ? { key, storeId: value }
    : { problem: `firefoxAddonGuid "${value}" is not a Firefox add-on GUID. Enter the GUID from your manifest or your AMO developer page, in the form name@example.com or {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}. ${AMO_GUID_RULING}` };
}

/* @invariant THE CLIENT HASHES THE BYTES THE SERVER HASHES. The approval is
 * a sha256 over {store, settings} with the settings keys in the order
 * enabled, dryRun, skipPublish, stagedPublish, publishAfter, releaseChannel,
 * sourceArchive, storeId, bundleId, only the keys the patch carries, rendered with
 * JSON.stringify. A digest that differs from the platform's asks a human to
 * approve a change that can never run, so it is refused instead.
 */
export function storeSettingsDigest(store: StoreSettingsStore, patch: StoreSettingsPatch): string {
  const settings: Row = {};

  for (const key of PATCH_KEYS) {
    if (key in patch) settings[key] = patch[key];
  }

  return crypto.createHash("sha256").update(JSON.stringify({ store, settings })).digest("hex");
}

export function requestedLines(store: StoreSettingsStore, requested: Row): string[] {
  return Object.entries(requested).map(([key, value]) => `${store}.${key}: ${JSON.stringify(value)}`);
}
