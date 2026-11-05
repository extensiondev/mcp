// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LISTING_TEXT_FIELDS, type ListingStore, type ListingText } from "./store-md-listing";
import { STORE_SCREENSHOT_SPECS, sizeLabel } from "./store-screenshot-sizes";

export const STORE_LISTING_ACTION = "extension_store.listing";

export const MAX_SCREENSHOTS = 10;
const SCREENSHOT_CAPS: Record<ListingStore, number> = { chrome: 5, edge: 6, firefox: MAX_SCREENSHOTS, safari: 10 };

export interface ScreenshotRule {
  max: number;
  sizes: readonly string[] | null;
  shown: string;
}

export function screenshotRule(store: ListingStore): ScreenshotRule {
  const spec = STORE_SCREENSHOT_SPECS[store];
  const max = SCREENSHOT_CAPS[store];
  if (store === "firefox") return { max, sizes: null, shown: "any size, optional" };

  const sizes = spec.sizes.map(sizeLabel);
  const listed = sizes.length > 1 ? `${sizes.slice(0, -1).join(", ")} or ${sizes[sizes.length - 1]}` : sizes[0]!;
  const shown =
    store === "safari"
      ? `${spec.count} macOS screenshots at exactly ${listed}, showing the extension running in Safari`
      : `${spec.count} at ${listed}`;

  return { max, sizes, shown };
}

const MAX_ICON_BYTES = 512 * 1024;
export const MAX_SCREENSHOT_BYTES = 1024 * 1024;
export const MAX_SCREENSHOT_MASTER_BYTES = 3 * 1024 * 1024;
const RESIZED_WIDTH = 1280;
const RESIZED_HEIGHT = 800;
const RESIZING_STORES: ReadonlySet<ListingStore> = new Set(["chrome", "edge"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ListingImage {
  sha256: string;
  width: number;
  height: number;
  bytes: Buffer;
  source: string;
}

export interface ListingPatch {
  listing: ListingText;
  icons?: ListingImage[];
  screenshots?: ListingImage[];
}

export function readPngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);

  return width > 0 && height > 0 ? { width, height } : null;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/* @invariant A MASTER OVER 1 MB IS TAKEN ONLY WHERE THE PLATFORM RESIZES IT.
 * www takes a screenshot up to 3 MB (MAX_SCREENSHOT_MASTER_BYTES, the write's
 * own media cap) and, for Chrome and Edge only, derives a 1280x800 copy of a
 * PNG wider than 1280 at 16:10 that is not already one of the store's sizes;
 * every image a store's listing receives, derived or sent as it is, is held to
 * 1 MB (www b04fd7654). Safari and Firefox get the master unresized, so a set
 * sent to either stays at 1 MB, and an image Chrome or Edge would receive as
 * it is stays at 1 MB too. Whether the derived copy fits is the platform's
 * answer, said verbatim.
 */
export function screenshotByteCap(stores: readonly ListingStore[]): number {
  return stores.length > 0 && stores.every((store) => RESIZING_STORES.has(store)) ? MAX_SCREENSHOT_MASTER_BYTES : MAX_SCREENSHOT_BYTES;
}

export function resizedForStore(store: ListingStore, image: { width: number; height: number }): boolean {
  if (!RESIZING_STORES.has(store)) return false;
  if (STORE_SCREENSHOT_SPECS[store].sizes.some(([width, height]) => width === image.width && height === image.height)) return false;

  return image.width > RESIZED_WIDTH && image.width * RESIZED_HEIGHT === image.height * RESIZED_WIDTH;
}

function overCap(source: string, bytes: number, maxBytes: number, stores: readonly ListingStore[]): string {
  return maxBytes === MAX_SCREENSHOT_BYTES && stores.some((store) => !RESIZING_STORES.has(store))
    ? `${source} is ${bytes} bytes, over the ${maxBytes} a Safari or Firefox listing takes as it is sent; only a set for Chrome and Edge alone may carry a 16:10 PNG up to ${MAX_SCREENSHOT_MASTER_BYTES} that the platform resizes to ${RESIZED_WIDTH}x${RESIZED_HEIGHT}`
    : `${source} is ${bytes} bytes, over the ${maxBytes} a listing image takes`;
}

function imageFromBytes(bytes: Buffer, maxBytes: number, source: string, stores: readonly ListingStore[] = []): ListingImage | string {
  const size = readPngSize(bytes);
  if (!size) return `${source} is not a PNG image`;
  if (bytes.length > maxBytes) return overCap(source, bytes.length, maxBytes, stores);

  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...size, bytes, source };
}

function readImage(file: string, maxBytes: number, source: string, stores: readonly ListingStore[] = []): ListingImage | string {
  let bytes: Buffer;

  try {
    bytes = fs.readFileSync(file);
  } catch {
    return `${source} could not be read`;
  }

  return imageFromBytes(bytes, maxBytes, source, stores);
}

export function icon128FromBytes(bytes: Buffer, source: string): { icon: ListingImage } | { missing: string } {
  const read = imageFromBytes(bytes, MAX_ICON_BYTES, source);
  if (typeof read === "string") return { missing: read };
  if (read.width !== 128 || read.height !== 128) return { missing: `${read.source} is ${read.width}x${read.height}, not 128x128` };

  return { icon: read };
}

export function declaredIcon128(manifest: unknown): string {
  const icons = isRecord(manifest) && isRecord(manifest.icons) ? manifest.icons : {};

  return typeof icons["128"] === "string" ? icons["128"].trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function distFor(projectPath: string, store: ListingStore): string | null {
  const order = store === "edge" ? ["edge", "chrome"] : store === "safari" ? ["safari", "chrome"] : [store, "chrome"];

  for (const name of order) {
    const dir = path.join(projectPath, "dist", name);
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  }

  return null;
}

function iconBesideManifest(projectPath: string, manifestFile: string): { icon: ListingImage } | { missing: string } {
  const dir = path.dirname(manifestFile);
  const relDir = path.relative(projectPath, dir) || ".";
  let declared = "";

  try {
    declared = declaredIcon128(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
  } catch {
    return { missing: `${relDir}/manifest.json could not be read` };
  }

  if (!declared) return { missing: `${relDir}/manifest.json declares no 128 px icon` };

  const file = path.resolve(dir, declared.replace(/^\/+/, ""));
  if (!inside(dir, file)) return { missing: `the 128 px icon ${declared} is outside ${relDir}` };

  const read = readImage(file, MAX_ICON_BYTES, path.relative(projectPath, file));
  if (typeof read === "string") return { missing: read };
  if (read.width !== 128 || read.height !== 128) return { missing: `${read.source} is ${read.width}x${read.height}, not 128x128` };

  return { icon: read };
}

export function iconFromDist(projectPath: string, store: ListingStore): { icon: ListingImage } | { missing: string } {
  const dir = distFor(projectPath, store);
  if (!dir) return { missing: `no built dist/${store}/manifest.json; build it with extension_build first` };

  return iconBesideManifest(projectPath, path.join(dir, "manifest.json"));
}

export function iconFromSource(projectPath: string): { icon: ListingImage } | { missing: string } {
  for (const file of [path.join(projectPath, "src", "manifest.json"), path.join(projectPath, "manifest.json")]) {
    if (fs.existsSync(file)) return iconBesideManifest(projectPath, file);
  }

  return { missing: "no manifest.json in the project" };
}

export function readScreenshots(
  projectPath: string,
  paths: unknown,
  stores: readonly ListingStore[] = [],
): { screenshots: ListingImage[] } | { problem: string } {
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.trim())) {
    return { problem: "screenshots must be an array of PNG paths inside projectPath" };
  }

  if (paths.length > MAX_SCREENSHOTS) return { problem: `a listing takes at most ${MAX_SCREENSHOTS} screenshots; ${paths.length} were given` };

  const root = fs.realpathSync(projectPath);
  const screenshots: ListingImage[] = [];

  for (const given of paths as string[]) {
    const absolute = path.resolve(root, given);
    let real: string;

    try {
      real = fs.realpathSync(absolute);
    } catch {
      return { problem: `screenshot ${given} does not exist` };
    }

    if (!inside(root, real) || path.extname(real).toLowerCase() !== ".png") {
      return { problem: `screenshot ${given} must be a .png file inside projectPath` };
    }

    const read = readImage(real, screenshotByteCap(stores), path.relative(root, real), stores);
    if (typeof read === "string") return { problem: read };

    screenshots.push(read);
  }

  return { screenshots };
}

export interface ScreenshotRefusal {
  store: ListingStore;
  message: string;
  file?: string;
  measured?: string;
  accepted?: readonly string[];
}

export function screenshotRefusal(store: ListingStore, screenshots: ListingImage[]): ScreenshotRefusal | null {
  const rule = screenshotRule(store);

  if (screenshots.length > rule.max) {
    return {
      store,
      message: `a ${store} listing takes at most ${rule.max} screenshots; ${screenshots.length} were given`,
    };
  }

  if (!rule.sizes) return null;

  for (const image of screenshots) {
    const measured = `${image.width}x${image.height}`;
    const resized = resizedForStore(store, image);

    if (!resized && image.bytes.length > MAX_SCREENSHOT_BYTES) {
      return {
        store,
        file: image.source,
        measured,
        accepted: rule.sizes,
        message: `${image.source} is ${image.bytes.length} bytes at ${measured}; the platform sends it to ${STORE_SCREENSHOT_SPECS[store].name} as it is, and a listing image it sends is at most ${MAX_SCREENSHOT_BYTES} bytes (only a 16:10 PNG wider than ${RESIZED_WIDTH} is resized to ${RESIZED_WIDTH}x${RESIZED_HEIGHT} and may be up to ${MAX_SCREENSHOT_MASTER_BYTES})`,
      };
    }

    if (resized || rule.sizes.includes(measured)) continue;

    return {
      store,
      file: image.source,
      measured,
      accepted: rule.sizes,
      message: `${image.source} is ${measured}; ${STORE_SCREENSHOT_SPECS[store].name} takes screenshots at exactly ${rule.sizes.join(", ")}`,
    };
  }

  return null;
}

const imageView = (image: ListingImage) => ({ sha256: image.sha256, width: image.width, height: image.height });

export function listingDigest(patch: ListingPatch): string {
  const listing: Record<string, unknown> = {};

  for (const field of [...LISTING_TEXT_FIELDS, "categories", "searchTerms", "permissionJustifications"] as const) {
    const value = (patch.listing as Record<string, unknown>)[field];
    if (value !== undefined) listing[field] = value;
  }

  const canonical: Record<string, unknown> = { listing };
  if (patch.icons) canonical.icons = patch.icons.map(imageView);
  if (patch.screenshots) canonical.screenshots = patch.screenshots.map(imageView);

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function writeBody(patch: ListingPatch): Record<string, unknown> {
  const media: Record<string, unknown> = {};
  if (patch.icons) media.icons = patch.icons.map((image) => ({ dataBase64: image.bytes.toString("base64") }));
  if (patch.screenshots) media.screenshots = patch.screenshots.map((image) => ({ dataBase64: image.bytes.toString("base64") }));

  return { listing: patch.listing, ...(Object.keys(media).length ? { media } : {}) };
}

export function approvalBody(store: ListingStore, patch: ListingPatch): Record<string, unknown> {
  const media: Record<string, unknown> = {};
  if (patch.icons) media.icons = patch.icons.map(imageView);
  if (patch.screenshots) media.screenshots = patch.screenshots.map(imageView);

  return { store, listing: patch.listing, ...(Object.keys(media).length ? { media } : {}) };
}
