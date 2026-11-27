// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { imageSize, keep, MAX_SCREENSHOTS, SCREENSHOT_SIZES, type ChromeLocale, type PlanFile } from "./chrome-listing-plan";
import { storeMdPath } from "./session-paths";
import { storeScreenshotsDir, storeScreenshotsFolder } from "./store-capture";
import { STORE_MD_FILENAME } from "./store-md";
import { localeSection } from "./store-md-declarations";
import { readText } from "./store-facts-local";
import { parseStoreMdListing } from "./store-md-listing";

const IMAGE = /\.(?:png|jpe?g)$/i;

function localeShots(projectPath: string, locale: string, dir: string, notes: string[]): PlanFile[] {
  const folder = path.join(storeScreenshotsDir(projectPath, "chrome"), locale);
  let names: string[];

  try {
    names = fs.readdirSync(folder).filter((name) => IMAGE.test(name)).sort();
  } catch {
    return [];
  }

  const kept: PlanFile[] = [];

  for (const name of names) {
    if (kept.length >= MAX_SCREENSHOTS) break;

    const bytes = fs.readFileSync(path.join(folder, name));
    const size = imageSize(bytes);
    const dims = size ? `${size.width}x${size.height}` : "";

    if (!size) notes.push(`${locale}/${name} is not a PNG or JPEG, so it was left out`);
    else if (!SCREENSHOT_SIZES.has(dims)) notes.push(`${locale}/${name} is ${dims}, and Chrome takes screenshots at 1280x800 or 640x400`);
    else kept.push(keep(dir, `${locale}-${name}`, bytes));
  }

  return kept;
}

/* @invariant A TRANSLATED CHROME LISTING COMES FROM THE PROJECT'S OWN
 * STORE.md, NEVER FROM THE PLATFORM SHEET. Each "## Listing (<tag>)" section
 * is one language: its Description is typed after that language is picked on
 * Store listing, and its screenshots are the images under
 * store/screenshots/chrome/<tag>/. Its Name and Summary are never typed,
 * since Chrome reads them from the package's _locales.
 */
export function chromeLocalesOf(projectPath: string, dir: string): { locales: ChromeLocale[]; notes: string[] } {
  const content = projectPath ? readText(storeMdPath(projectPath)) : null;
  if (!content) return { locales: [], notes: [] };

  const notes: string[] = [];
  const locales = Object.entries(parseStoreMdListing(content).locales).map(([locale, text]) => ({
    locale,
    description: text.fullDescription ?? "",
    screenshots: localeShots(projectPath, locale, dir, notes),
    from: `${localeSection(locale)} in ${STORE_MD_FILENAME}`,
    folder: `${storeScreenshotsFolder("chrome")}/${locale}/`,
  }));

  return { locales, notes };
}
