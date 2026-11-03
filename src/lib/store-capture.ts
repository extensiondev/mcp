// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { LISTING_STORES, type ListingStore } from "./store-md-declarations";

export const STORE_SCREENSHOTS_DIR = "store/screenshots";
export const STORE_CHOICES = [...LISTING_STORES, "all"] as const;

export type StoreChoice = (typeof STORE_CHOICES)[number];
export type CaptureFamily = "chromium" | "gecko" | "webkit";

export interface CapturePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

const SHARED_PRESET: CapturePreset = { width: 1280, height: 800, deviceScaleFactor: 1 };

export const STORE_CAPTURE_PRESETS: Record<ListingStore, CapturePreset> = {
  chrome: SHARED_PRESET,
  edge: SHARED_PRESET,
  firefox: SHARED_PRESET,
  safari: { width: 1440, height: 900, deviceScaleFactor: 2 },
};

export const PRESET_SENTENCE = "chrome, edge and firefox 1280x800 at 1x; safari 1440x900 at 2x, a 2880x1800 image";

const CAPTURE_ORDER: readonly ListingStore[] = ["chrome", "edge", "firefox", "safari"];

export interface CaptureShot {
  stores: ListingStore[];
  preset: CapturePreset;
}

export interface CapturePlan {
  shots: CaptureShot[];
  skipped: ListingStore[];
}

export function isStoreChoice(value: unknown): value is StoreChoice {
  return (STORE_CHOICES as readonly string[]).includes(String(value));
}

export const expectedPixels = (preset: CapturePreset): string => `${preset.width * preset.deviceScaleFactor}x${preset.height * preset.deviceScaleFactor}`;

/* @invariant ONE CAPTURE SERVES EVERY STORE THAT SHARES A SIZE. chrome, edge
 * and firefox all take 1280x800 at 1x, so store:"all" on a Chromium or Gecko
 * session captures the page once at that size and files the same pixels
 * under each of the three folders, then captures once more at Safari's
 * 1440x900 at 2x. Safari's WebDriver window comes at the display's pixel
 * ratio and cannot render another store's 1x size, so "all" there writes the
 * safari file alone and the answer names the three stores it skipped.
 */
export function capturePlan(choice: StoreChoice, family: CaptureFamily): CapturePlan {
  const wanted: ListingStore[] = choice === "all" ? [...CAPTURE_ORDER] : [choice];
  const stores = family === "webkit" && choice === "all" ? wanted.filter((store) => store === "safari") : wanted;
  const skipped = wanted.filter((store) => !stores.includes(store));
  const shots: CaptureShot[] = [];

  for (const store of stores) {
    const preset = STORE_CAPTURE_PRESETS[store];
    const shared = shots.find((shot) => shot.preset === preset);

    if (shared) shared.stores.push(store);
    else shots.push({ stores: [store], preset });
  }

  return { shots, skipped };
}

export function storeScreenshotsDir(projectPath: string, store: ListingStore): string {
  return path.join(path.resolve(projectPath), STORE_SCREENSHOTS_DIR, store);
}

export const storeScreenshotsFolder = (store: ListingStore): string => `${STORE_SCREENSHOTS_DIR}/${store}`;

const NUMBERED = /^(\d+)\.png$/i;

export function nextStoreScreenshotPath(projectPath: string, store: ListingStore): string {
  const dir = storeScreenshotsDir(projectPath, store);
  let taken: number[] = [];

  try {
    taken = fs
      .readdirSync(dir)
      .map((name) => NUMBERED.exec(name))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => Number(match[1]));
  } catch {
    taken = [];
  }

  const next = taken.length ? Math.max(...taken) + 1 : 1;

  return path.join(dir, `${String(next).padStart(2, "0")}.png`);
}

export function captureRecipe(store: ListingStore): string {
  return `Screenshots for ${store}: extension_screenshot store:"${store}" on a ${store === "safari" ? "Safari" : "Chromium"} dev session, one call per view, then sync-listing browsers:["${store}"] picks them up from ${storeScreenshotsFolder(store)}/.`;
}

export function listStoreScreenshots(projectPath: string, store: ListingStore): string[] {
  const dir = storeScreenshotsDir(projectPath, store);

  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort()
      .map((name) => `${storeScreenshotsFolder(store)}/${name}`);
  } catch {
    return [];
  }
}
