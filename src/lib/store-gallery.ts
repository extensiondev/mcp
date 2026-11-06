// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { pngHeader } from "./png-flat";
import { captureRecipe, listStoreScreenshots, storeScreenshotsFolder } from "./store-capture";
import { clearsStoreRow, sizeLabel, STORE_SCREENSHOT_SPECS } from "./store-screenshot-sizes";

import type { ListingStore } from "./store-md-declarations";

export interface GalleryShot {
  file: string;
  size: string;
  clears: boolean;
  reason?: string;
}

export interface GalleryStore {
  store: ListingStore;
  folder: string;
  takes: string;
  shots: GalleryShot[];
  ready: boolean;
  say: string;
}

const MIN_SHOTS: Record<ListingStore, number> = { chrome: 1, edge: 1, firefox: 0, safari: 1 };
const MAX_SHOTS: Record<ListingStore, number> = { chrome: 5, edge: 6, firefox: 10, safari: 10 };

function shotOf(projectPath: string, store: ListingStore, file: string): GalleryShot {
  let header: ReturnType<typeof pngHeader> = null;

  try {
    header = pngHeader(fs.readFileSync(path.join(projectPath, file)));
  } catch {
    header = null;
  }

  if (!header) return { file, size: "unreadable", clears: false, reason: "not a readable PNG" };

  const verdict = clearsStoreRow(store, header.width, header.height, header.alpha !== "none");

  return { file, size: `${header.width}x${header.height}`, clears: verdict.clears, ...(verdict.reason ? { reason: verdict.reason } : {}) };
}

/* @invariant THE GALLERY JUDGES EACH FILE BY THE STORE'S OWN NUMBERS, AND
 * SAYS WHAT IS SHORT BEFORE THE PERSON LOOKS. Each store's folder under
 * store/screenshots is read in file order, every PNG measured from its own
 * header against STORE_SCREENSHOT_SPECS (size and alpha), and the store is
 * ready only when it holds at least the store's minimum, no more than its
 * maximum, and every file clears; an empty folder answers the capture call
 * that fills it at the store's size, so nobody sizes an image by hand.
 */
export function storeGalleryOf(projectPath: string, stores: readonly ListingStore[]): GalleryStore[] {
  return stores.map((store) => {
    const spec = STORE_SCREENSHOT_SPECS[store];
    const shots = listStoreScreenshots(projectPath, store).map((file) => shotOf(projectPath, store, file));
    const refused = shots.filter((shot) => !shot.clears);
    const short = shots.length < MIN_SHOTS[store];
    const over = shots.length > MAX_SHOTS[store];
    const ready = !short && !over && refused.length === 0;
    const takes = `${spec.count} at ${spec.sizes.map(sizeLabel).join(" or ")} px${spec.alpha === "refused" ? ", no alpha" : ""}`;
    const say = !shots.length
      ? short
        ? `${spec.name} needs at least ${MIN_SHOTS[store]} and ${storeScreenshotsFolder(store)}/ is empty. ${captureRecipe(store)}`
        : `${storeScreenshotsFolder(store)}/ is empty; ${spec.name} takes screenshots but does not require one.`
      : refused.length
        ? `${refused.map((shot) => `${shot.file}: ${shot.reason}`).join("; ")}. Retake ${refused.length === 1 ? "it" : "them"} with extension_screenshot store:"${store}".`
        : over
          ? `${shots.length} files, over the ${MAX_SHOTS[store]} ${spec.name} takes; drop ${shots.length - MAX_SHOTS[store]}.`
          : `${shots.length} ${shots.length === 1 ? "screenshot clears" : "screenshots clear"} ${spec.name}; show ${shots.length === 1 ? "it" : "them"} to the person for approval.`;

    return { store, folder: storeScreenshotsFolder(store), takes, shots, ready, say };
  });
}
