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
import { STORE_MD_FILENAME } from "./store-md";
import { clearsStoreRow, sizeLabel, STORE_SCREENSHOT_SPECS } from "./store-screenshot-sizes";

import type { ListingStore } from "./store-md-declarations";

export interface GalleryShot {
  file: string;
  size: string;
  clears: boolean;
  reason?: string;
}

export type GallerySource = "folder" | "store-md" | "none";

export interface GalleryStore {
  store: ListingStore;
  folder: string;
  source: GallerySource;
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

function namedOnDisk(projectPath: string, named: readonly string[]): { found: string[]; missing: string[] } {
  const root = (() => {
    try {
      return fs.realpathSync(projectPath);
    } catch {
      return path.resolve(projectPath);
    }
  })();
  const found: string[] = [];
  const missing: string[] = [];

  for (const given of named) {
    try {
      const real = fs.realpathSync(path.resolve(root, given));
      const relative = path.relative(root, real);
      const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);

      (inside && fs.statSync(real).isFile() ? found : missing).push(inside ? relative.split(path.sep).join("/") : given);
    } catch {
      missing.push(given);
    }
  }

  return { found, missing };
}

function shotsSay(store: ListingStore, shots: GalleryShot[], over: boolean, refused: GalleryShot[]): string {
  const spec = STORE_SCREENSHOT_SPECS[store];

  if (refused.length) return `${refused.map((shot) => `${shot.file}: ${shot.reason}`).join("; ")}. Retake ${refused.length === 1 ? "it" : "them"} with extension_screenshot store:"${store}".`;
  if (over) return `${shots.length} files, over the ${MAX_SHOTS[store]} ${spec.name} takes; drop ${shots.length - MAX_SHOTS[store]}.`;

  return `${shots.length} ${shots.length === 1 ? "screenshot clears" : "screenshots clear"} ${spec.name}; show ${shots.length === 1 ? "it" : "them"} to the person for approval.`;
}

/* @invariant THE GALLERY JUDGES THE FILES THE LISTING SENDS, BY THE STORE'S
 * OWN NUMBERS, AND SAYS WHAT IS SHORT BEFORE THE PERSON LOOKS. Each store's
 * folder under store/screenshots is read first, in file order; when it holds
 * no PNG, the files STORE.md's Screenshots line names inside projectPath are
 * read instead (ledger 476), so a project shipped with those never reads as
 * empty, and a named file that is not there is named in say, not counted.
 * Every PNG is measured from its own header against STORE_SCREENSHOT_SPECS
 * (size and alpha), and the store is ready only when it holds at least the
 * store's minimum, no more than its maximum, and every file clears; source
 * says which of the two was read, and only when neither yields a file does
 * say carry the capture call that fills the folder at the store's size.
 */
export function storeGalleryOf(projectPath: string, stores: readonly ListingStore[], named: readonly string[] = []): GalleryStore[] {
  const fromStoreMd = namedOnDisk(projectPath, named);
  const gone = fromStoreMd.missing.length ? ` Not found: ${fromStoreMd.missing.join(", ")}.` : "";

  return stores.map((store) => {
    const spec = STORE_SCREENSHOT_SPECS[store];
    const inFolder = listStoreScreenshots(projectPath, store);
    const source: GallerySource = inFolder.length ? "folder" : fromStoreMd.found.length ? "store-md" : "none";
    const files = source === "folder" ? inFolder : fromStoreMd.found;
    const shots = files.map((file) => shotOf(projectPath, store, file));
    const refused = shots.filter((shot) => !shot.clears);
    const short = shots.length < MIN_SHOTS[store];
    const over = shots.length > MAX_SHOTS[store];
    const ready = !short && !over && refused.length === 0;
    const takes = `${spec.count} at ${spec.sizes.map(sizeLabel).join(" or ")} px${spec.alpha === "refused" ? ", no alpha" : ""}`;
    const empty = `${storeScreenshotsFolder(store)}/ is empty${named.length ? ` and ${STORE_MD_FILENAME} names no file on disk` : ""}`;
    const say = !shots.length
      ? short
        ? `${spec.name} needs at least ${MIN_SHOTS[store]} and ${empty}.${gone} ${captureRecipe(store)}`
        : `${empty}; ${spec.name} takes screenshots but does not require one.${gone}`
      : `${shotsSay(store, shots, over, refused)}${source === "store-md" ? gone : ""}`;

    return { store, folder: storeScreenshotsFolder(store), source, takes, shots, ready, say };
  });
}
