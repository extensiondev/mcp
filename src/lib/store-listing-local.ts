// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { chromePasteLines, type PasteLines } from "./chrome-paste-lines";
import { withChromeVisibility } from "./chrome-visibility";
import { chromeWebStoreHeld, chromeWebStoreHeldSentence, chromeWebStoreMdOf } from "./chromewebstore-md";
import { storeMdPath } from "./session-paths";
import { STORE_MD_FILENAME } from "./store-md";
import { STORE_FIELDS, listingForStore, parseStoreMdListing, type ListingField, type ListingStore, type StoreMdPrivacy, type UnreadLine } from "./store-md-listing";
import { storeMdOverLimitOf, type StoreMdOverLimit } from "./store-md-over-limit";
import { screenshotsLineSentence } from "./store-md-screenshots";
import { factOf, type IconOrigin, type IconStale, type LocalIcon, type ProjectFacts } from "./submit-facts";

import type { CategoryRead } from "./store-categories";
import type { ListingImage, ListingPatch } from "./store-listing-media";

/* @invariant WHAT STORE.md SAYS FOR A STORE IS READ ONCE, FROM THE FACTS. The
 * local server reads the project's files and the hosted half reads the same
 * facts the forwarder sent, so one reader turns them into a listing: the
 * fields the store takes, the lines that could not be read, what is over a
 * limit, and the icon the facts carry or why there is none.
 */
export interface LocalListing {
  file: string;
  store: ListingStore;
  patch: ListingPatch;
  icon?: IconOrigin;
  iconMissing?: string;
  iconStale?: IconStale;
  iconNote?: string;
  skipped: string[];
  unread: Partial<Record<ListingField, UnreadLine>>;
  overLimit: StoreMdOverLimit[];
  borrowed?: Partial<Record<ListingField, string>>;
  screenshotsLine?: string;
  lines: Partial<Record<ListingField, string>>;
  privacy: StoreMdPrivacy;
  categories?: CategoryRead;
  screenshotsNamed?: number;
  pasteLines?: PasteLines;
}

export type LocalListingRead = LocalListing | { problem: string } | null;

export type ListingFacts = Pick<ProjectFacts, "projectPath" | "storeMd" | "chromeWebStoreMd" | "icons">;

const NO_ICON_READ: LocalIcon = { missing: "no manifest.json in the project" };

export function localListingOf(
  project: ListingFacts,
  store: ListingStore,
  screenshots?: ListingImage[],
): LocalListing | { problem: string } {
  const file = storeMdPath(project.projectPath);
  const content = project.storeMd;

  if (content === null) {
    const held = chromeWebStoreHeld(chromeWebStoreMdOf(project.chromeWebStoreMd), store, STORE_FIELDS[store]);

    return {
      problem: `No ${STORE_MD_FILENAME} at ${file}. ${held.length ? chromeWebStoreHeldSentence(held, false) : "Create it with the listing copy first (the browser-extension skill's store-md reference has the shape)."}`,
    };
  }

  const parsed = parseStoreMdListing(content);
  const read = listingForStore(parsed, store);
  const { listing, skipped, unread } = withChromeVisibility(read, parsed.lines.visibility);
  const icon = factOf(project.icons, store) ?? NO_ICON_READ;
  const patch: ListingPatch = { listing };
  const screenshotsLine = parsed.screenshotsLine && !screenshots?.length ? screenshotsLineSentence(parsed.screenshotsLine, parsed.screenshotFiles ?? 0) : "";

  if ("icon" in icon) patch.icons = [icon.icon];
  if (screenshots?.length) patch.screenshots = screenshots;

  return {
    file,
    store,
    patch,
    skipped,
    unread,
    overLimit: read.overLimit.map(({ field, ...measure }) => storeMdOverLimitOf(store, field, measure, parsed.lines[field])),
    ...(read.borrowed ? { borrowed: read.borrowed } : {}),
    ...(screenshotsLine ? { screenshotsLine } : {}),
    lines: parsed.lines,
    privacy: parsed.privacy,
    ...(parsed.screenshotsLine ? { screenshotsNamed: parsed.screenshotFiles ?? 0 } : {}),
    ...(store === "chrome" ? { pasteLines: chromePasteLines(content) } : {}),
    ...(read.categories ? { categories: read.categories } : {}),
    ...("icon" in icon ? { icon: icon.origin } : { iconMissing: icon.missing }),
    ...("stale" in icon && icon.stale ? { iconStale: icon.stale } : {}),
  };
}
