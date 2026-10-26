// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LISTING_STORES, type ListingStore } from "./store-md-declarations";

export interface StoreScreenshotSpec {
  store: ListingStore;
  name: string;
  sizes: ReadonlyArray<readonly [number, number]>;
  count: string;
  alpha: "refused" | "accepted";
  docs: string;
}

export const SHARED_SCREENSHOT_SIZE: readonly [number, number] = [1280, 800];

/* @invariant THE SIZES ARE THE STORES' OWN, AND ONE OF THEM SERVES ALL FOUR.
 * Each row is what the store's documentation accepts for a listing
 * screenshot, in its own numbers: Chrome 1280x800 or 640x400 as JPEG or
 * 24-bit PNG with no alpha; Edge 640x480 or 1280x800; the App Store exactly
 * 1280x800, 1440x900, 2560x1600 or 2880x1800 with no alpha channel; Firefox
 * any PNG or JPEG, 1280x800 reading best. 1280x800 is in every row, so a
 * capture at that size flattened to 24-bit clears the screenshot row of
 * every store at once; the platform's requirement rows judge the image by
 * the same numbers.
 */
export const STORE_SCREENSHOT_SPECS: Record<ListingStore, StoreScreenshotSpec> = {
  chrome: {
    store: "chrome",
    name: "the Chrome Web Store",
    sizes: [[1280, 800], [640, 400]],
    count: "1 to 5",
    alpha: "refused",
    docs: "https://developer.chrome.com/docs/webstore/images",
  },
  firefox: {
    store: "firefox",
    name: "Firefox Add-ons",
    sizes: [[1280, 800]],
    count: "any number, optional",
    alpha: "accepted",
    docs: "https://extensionworkshop.com/documentation/publish/submitting-an-add-on/",
  },
  edge: {
    store: "edge",
    name: "Edge Add-ons",
    sizes: [[1280, 800], [640, 480]],
    count: "1 to 10",
    alpha: "accepted",
    docs: "https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension",
  },
  safari: {
    store: "safari",
    name: "the App Store",
    sizes: [[1280, 800], [1440, 900], [2560, 1600], [2880, 1800]],
    count: "1 to 10",
    alpha: "refused",
    docs: "https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications",
  },
};

export const sizeLabel = (size: readonly [number, number]): string => `${size[0]}x${size[1]}`;

export function isListingStoreName(value: unknown): value is ListingStore {
  return (LISTING_STORES as readonly string[]).includes(String(value));
}

export function storeSizeSentence(store: ListingStore): string {
  const spec = STORE_SCREENSHOT_SPECS[store];
  const sizes = spec.sizes.map(sizeLabel).join(" or ");

  return `${spec.name} takes ${spec.count} screenshots at ${sizes} px${spec.alpha === "refused" ? ", 24-bit PNG or JPEG with no alpha" : ", PNG or JPEG"} (${spec.docs}).`;
}

export type StoreSizePick = { ok: true; width: number; height: number } | { ok: false; message: string };

export function pickStoreSize(store: ListingStore, width?: number, height?: number): StoreSizePick {
  const spec = STORE_SCREENSHOT_SPECS[store];

  if (width === undefined && height === undefined) return { ok: true, width: SHARED_SCREENSHOT_SIZE[0], height: SHARED_SCREENSHOT_SIZE[1] };

  const accepted = spec.sizes.find((size) => size[0] === width && size[1] === height);
  if (accepted) return { ok: true, width: accepted[0], height: accepted[1] };

  return {
    ok: false,
    message: `${width ?? "?"}x${height ?? "?"} is not a size ${spec.name} accepts for a screenshot; pass one of ${spec.sizes.map(sizeLabel).join(", ")}, or omit width and height for ${sizeLabel(SHARED_SCREENSHOT_SIZE)}.`,
  };
}

export function clearsStoreRow(store: ListingStore, width: number, height: number, hasAlpha: boolean): { clears: boolean; reason?: string } {
  const spec = STORE_SCREENSHOT_SPECS[store];
  const size = spec.sizes.some((s) => s[0] === width && s[1] === height);

  if (!size) return { clears: false, reason: `${width}x${height} px is not a size ${spec.name} accepts (${spec.sizes.map(sizeLabel).join(", ")})` };
  if (hasAlpha && spec.alpha === "refused") return { clears: false, reason: `${spec.name} refuses an alpha channel` };

  return { clears: true };
}
