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

export const STORE_LISTING_ACTION = "extension_store.listing";

export const MAX_SCREENSHOTS = 5;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_SCREENSHOT_BYTES = 1024 * 1024;
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

function imageFromBytes(bytes: Buffer, maxBytes: number, source: string): ListingImage | string {
  const size = readPngSize(bytes);
  if (!size) return `${source} is not a PNG image`;
  if (bytes.length > maxBytes) return `${source} is ${bytes.length} bytes, over the ${maxBytes} a listing image takes`;

  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...size, bytes, source };
}

function readImage(file: string, maxBytes: number, source: string): ListingImage | string {
  let bytes: Buffer;

  try {
    bytes = fs.readFileSync(file);
  } catch {
    return `${source} could not be read`;
  }

  return imageFromBytes(bytes, maxBytes, source);
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

export function readScreenshots(projectPath: string, paths: unknown): { screenshots: ListingImage[] } | { problem: string } {
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

    const read = readImage(real, MAX_SCREENSHOT_BYTES, path.relative(root, real));
    if (typeof read === "string") return { problem: read };

    screenshots.push(read);
  }

  return { screenshots };
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
