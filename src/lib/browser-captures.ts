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

import { pngHeader } from "./png-flat";
import { MAX_SCREENSHOT_BYTES, readPngSize } from "./store-listing-media";

export const BROWSER_CAPTURES_ACTION = "extension_browsers.captures";
export const CAPTURES_DIR = "captures";
export const CAPTURES_INDEX = "captures.json";
export const CAPTURE_BROWSERS = ["chrome", "firefox", "edge", "safari"] as const;
export const CAPTURE_SURFACES = ["popup", "options", "sidebar", "newtab", "page", "devtools", "window"] as const;
export const MAX_CAPTURES = 10;
export const MIN_CAPTURE_WIDTH = 640;
export const MAX_CAPTION_LENGTH = 120;

export type CaptureBrowser = (typeof CAPTURE_BROWSERS)[number];
export type CaptureSurface = (typeof CAPTURE_SURFACES)[number];

export interface CapturedIn {
  name: string;
  version: string;
}

export interface CaptureEntry {
  file: string;
  surface: CaptureSurface;
  width: number;
  height: number;
  capturedAt: string;
  caption?: string;
}

export interface CapturesIndex {
  browser: CaptureBrowser;
  capturedIn?: CapturedIn;
  captures: CaptureEntry[];
}

export interface LocalCapture {
  file: string;
  sha256: string;
  width: number;
  height: number;
  bytes: Buffer;
  surface?: CaptureSurface;
  caption?: string;
}

const BROWSER_NAMES: Record<CaptureBrowser, string> = { chrome: "Chrome", firefox: "Firefox", edge: "Edge", safari: "Safari" };

export function isCaptureBrowser(value: unknown): value is CaptureBrowser {
  return (CAPTURE_BROWSERS as readonly string[]).includes(String(value));
}

export const browserDisplayName = (browser: CaptureBrowser): string => BROWSER_NAMES[browser];

export const capturesFolder = (browser: CaptureBrowser): string => `${CAPTURES_DIR}/${browser}`;

export function capturesDir(projectPath: string, browser: CaptureBrowser): string {
  return path.join(path.resolve(projectPath), CAPTURES_DIR, browser);
}

export function surfaceOfContext(context: string): CaptureSurface {
  return (CAPTURE_SURFACES as readonly string[]).includes(context) ? (context as CaptureSurface) : "page";
}

export function majorVersion(capturedIn: CapturedIn | null | undefined): string {
  const major = /^\d+/.exec(capturedIn?.version ?? "")?.[0] ?? "";

  return capturedIn ? `${capturedIn.name}${major ? ` ${major}` : ""}` : "";
}

export function nextCapturePath(projectPath: string, browser: CaptureBrowser, context: string): string {
  const dir = capturesDir(projectPath, browser);
  const numbered = new RegExp(`^${context}-(\\d+)\\.png$`, "i");
  let taken: number[] = [];

  try {
    taken = fs
      .readdirSync(dir)
      .map((name) => numbered.exec(name))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => Number(match[1]));
  } catch {
    taken = [];
  }

  const next = taken.length ? Math.max(...taken) + 1 : 1;

  return path.join(dir, `${context}-${String(next).padStart(2, "0")}.png`);
}

export function readCapturesIndex(projectPath: string, browser: CaptureBrowser): CapturesIndex {
  const empty: CapturesIndex = { browser, captures: [] };

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(capturesDir(projectPath, browser), CAPTURES_INDEX), "utf8")) as Partial<CapturesIndex>;
    const captures = Array.isArray(raw.captures) ? raw.captures.filter((entry): entry is CaptureEntry => Boolean(entry) && typeof entry === "object" && typeof entry.file === "string") : [];
    const capturedIn = readCapturedIn(raw.capturedIn);

    return { browser, ...(capturedIn ? { capturedIn } : {}), captures };
  } catch {
    return empty;
  }
}

export function readCapturedIn(value: unknown): CapturedIn | null {
  if (!value || typeof value !== "object") return null;

  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const version = typeof row.version === "string" ? row.version.trim() : "";

  return name && version ? { name, version } : null;
}

/* @invariant THE CAPTURE INDEX NAMES THE BROWSER THAT MADE THE NEWEST FILE.
 * One captures.json sits beside the files of one browser; every capture
 * written into the folder upserts its own row by file name and replaces
 * capturedIn with the live session's answer, so a folder captured across two
 * browser updates says the newest one, and a hand-placed file with no row
 * still syncs with no surface and no caption. */
export function recordCapture(projectPath: string, browser: CaptureBrowser, entry: CaptureEntry, capturedIn: CapturedIn | null): CapturesIndex {
  const index = readCapturesIndex(projectPath, browser);
  const captures = index.captures.filter((row) => row.file !== entry.file);
  captures.push(entry);
  captures.sort((a, b) => a.file.localeCompare(b.file));

  const next: CapturesIndex = { browser, ...(capturedIn ? { capturedIn } : index.capturedIn ? { capturedIn: index.capturedIn } : {}), captures };
  const dir = capturesDir(projectPath, browser);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CAPTURES_INDEX), `${JSON.stringify(next, null, 2)}\n`);

  return next;
}

export function listCaptureFiles(projectPath: string, browser: CaptureBrowser): string[] {
  try {
    return fs
      .readdirSync(capturesDir(projectPath, browser))
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort();
  } catch {
    return [];
  }
}

export type CapturesRead = { captures: LocalCapture[]; capturedIn: CapturedIn | null; folder: string; files: string[] } | { problem: string; file?: string };

/* @invariant A CAPTURE SET IS REFUSED HERE BEFORE ANY APPROVAL IS ASKED FOR.
 * The platform's rules for a browser capture (PNG, no alpha, one to ten per
 * browser, at least 640 wide, under the listing image byte cap, a caption of
 * 120 characters at most) are measured on the files in captures/<browser>/
 * before the first PUT, so an owner is never sent an approval page for a set
 * the platform would refuse once approved. */
export function readCaptures(projectPath: string, browser: CaptureBrowser): CapturesRead {
  const folder = capturesFolder(browser);
  const files = listCaptureFiles(projectPath, browser);

  if (!files.length) return { problem: `${folder}/ holds no .png file` };
  if (files.length > MAX_CAPTURES) return { problem: `${folder}/ holds ${files.length} .png files; a browser takes at most ${MAX_CAPTURES} captures` };

  const index = readCapturesIndex(projectPath, browser);
  const rows = new Map(index.captures.map((entry) => [entry.file, entry]));
  const captures: LocalCapture[] = [];

  for (const name of files) {
    const file = `${folder}/${name}`;
    let bytes: Buffer;

    try {
      bytes = fs.readFileSync(path.join(capturesDir(projectPath, browser), name));
    } catch {
      return { problem: `${file} could not be read`, file };
    }

    const size = readPngSize(bytes);
    if (!size) return { problem: `${file} is not a PNG image`, file };

    const header = pngHeader(bytes);
    if (!header || header.alpha !== "none") return { problem: `${file} carries an alpha channel; a browser capture is a 24-bit PNG with no transparency`, file };
    if (size.width < MIN_CAPTURE_WIDTH) return { problem: `${file} is ${size.width}x${size.height}; a browser capture is at least ${MIN_CAPTURE_WIDTH} pixels wide`, file };
    if (bytes.length > MAX_SCREENSHOT_BYTES) return { problem: `${file} is ${bytes.length} bytes, over the ${MAX_SCREENSHOT_BYTES} an image takes`, file };

    const row = rows.get(name);
    const caption = typeof row?.caption === "string" ? row.caption.trim() : "";
    if (caption.length > MAX_CAPTION_LENGTH) return { problem: `${file} has a caption of ${caption.length} characters in ${folder}/${CAPTURES_INDEX}; a caption takes at most ${MAX_CAPTION_LENGTH}`, file };

    const surface = row && (CAPTURE_SURFACES as readonly string[]).includes(row.surface) ? row.surface : undefined;

    captures.push({
      file,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      ...size,
      bytes,
      ...(surface ? { surface } : {}),
      ...(caption ? { caption } : {}),
    });
  }

  return { captures, capturedIn: index.capturedIn ?? null, folder, files };
}

/* @invariant THE DIGEST IS THE PLATFORM'S OWN RECIPE, BYTE FOR BYTE. The
 * approval scope both sides fingerprint is { browser, capturesDigest }, and
 * capturesDigest is sha256 of JSON.stringify({ capturedIn: {name, version}
 * or null, captures: [{ sha256, surface or null, caption or null }] }) in
 * array order, as www computes it in its browsers captures route; a key
 * added, dropped or reordered here makes every approval a scope mismatch. */
export function capturesDigest(captures: LocalCapture[], capturedIn: CapturedIn | null): string {
  const canonical = {
    capturedIn: capturedIn ? { name: capturedIn.name, version: capturedIn.version } : null,
    captures: captures.map((capture) => ({ sha256: capture.sha256, surface: capture.surface ?? null, caption: capture.caption ?? null })),
  };

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function syncBody(captures: LocalCapture[], capturedIn: CapturedIn | null): Record<string, unknown> {
  return {
    captures: captures.map((capture) => ({
      sha256: capture.sha256,
      dataBase64: capture.bytes.toString("base64"),
      ...(capture.surface ? { surface: capture.surface } : {}),
      ...(capture.caption ? { caption: capture.caption } : {}),
    })),
    ...(capturedIn ? { capturedIn } : {}),
  };
}

export function approvalBody(browser: CaptureBrowser, captures: LocalCapture[], capturedIn: CapturedIn | null): Record<string, unknown> {
  return { browser, ...syncBody(captures, capturedIn) };
}

export function syncCapturesDoor(browser: CaptureBrowser): string {
  return `One call per surface; extension_publish action:"sync-captures" browsers:["${browser}"] sends ${capturesFolder(browser)}/ to the public build page after a workspace owner approves.`;
}
