// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_SCREENSHOT_SPECS } from "./store-screenshot-sizes";

import type { ListingPatch } from "./store-listing-media";
import type { ListingStore } from "./store-md-listing";

export const PLATFORM_REQUEST_BODY_LIMIT_BYTES = 4_500_000;
export const PLATFORM_REQUEST_BODY_LIMIT_SOURCE = "Vercel request body limit";
export const LISTING_TOO_LARGE_STATUS = "listing-too-large";

const SCREENSHOT_ROW_OVERHEAD = Buffer.byteLength(JSON.stringify({ dataBase64: "" })) + 1;
const SMALL_CAPTURE = "1280x800";

export interface ListingBodyFile {
  name: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ListingBodyView {
  bytes: number;
  limitBytes: number;
  files: ListingBodyFile[];
}

export function measureListingBody(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

export function listingBodyView(patch: ListingPatch, bytes: number): ListingBodyView {
  const files = (patch.screenshots ?? [])
    .map((image) => ({ name: image.source, bytes: image.bytes.length, width: image.width, height: image.height }))
    .sort((a, b) => b.bytes - a.bytes);

  return { bytes, limitBytes: PLATFORM_REQUEST_BODY_LIMIT_BYTES, files };
}

function encodedRowBytes(raw: number): number {
  return Math.ceil(raw / 3) * 4 + SCREENSHOT_ROW_OVERHEAD;
}

export function screenshotsThatFit(patch: ListingPatch, bytes: number): number {
  const shots = patch.screenshots ?? [];
  let used = bytes - shots.reduce((sum, image) => sum + encodedRowBytes(image.bytes.length), 0);
  let count = 0;

  for (const image of shots) {
    const next = used + encodedRowBytes(image.bytes.length);
    if (next > PLATFORM_REQUEST_BODY_LIMIT_BYTES) break;

    used = next;
    count += 1;
  }

  return count;
}

function acceptsSmallCapture(store: ListingStore): boolean {
  return STORE_SCREENSHOT_SPECS[store].sizes.some(([width, height]) => `${width}x${height}` === SMALL_CAPTURE);
}

export function listingTooLargeMessage(store: ListingStore, view: ListingBodyView, refusedByPlatform: boolean): string {
  const lead = refusedByPlatform
    ? `${store}: the platform refused the body as too large (413); it measures ${view.bytes} bytes`
    : `${store}: the sync-listing request body measures ${view.bytes} bytes`;

  return `${lead}, over the ${view.limitBytes}-byte request body limit (${PLATFORM_REQUEST_BODY_LIMIT_SOURCE}). Nothing was written to the listing by this call.`;
}

export function listingTooLargeHint(store: ListingStore, patch: ListingPatch, view: ListingBodyView): string {
  const files = view.files.map((file) => `${file.name} ${file.bytes} bytes at ${file.width}x${file.height}`).join(", ");
  const fit = screenshotsThatFit(patch, view.bytes);
  const fewer =
    fit >= view.files.length
      ? "by this measure the whole set fits, so the platform's cap is below the one named here; send one screenshot per call of sync-listing with the same browsers and projectPath"
      : fit > 0
        ? `${fit} of these fit${fit === 1 ? "s" : ""} in one call, so send them in ${Math.ceil(view.files.length / fit)} calls of sync-listing with the same browsers and projectPath and a subset of screenshots each`
        : "none of these fits in one call even alone";
  const smaller = acceptsSmallCapture(store)
    ? `, or capture at ${SMALL_CAPTURE}, which ${STORE_SCREENSHOT_SPECS[store].name} accepts too and weighs about a quarter of the bytes`
    : "";

  return `The body is JSON and every PNG goes in it base64-encoded, which adds a third to its bytes; the limit is ${view.limitBytes} bytes in total. Files, biggest first: ${files}. Fix: ${fewer}${smaller}.`;
}
