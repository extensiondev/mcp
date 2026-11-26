// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { CHROME_FIELDS } from "./chrome-dashboard-agent";
import { addRow, attach, fillText } from "./chrome-listing-fill";
import { imageSize, keep, MAX_SCREENSHOTS, SCREENSHOT_SIZES, type ChromeLocale, type PlanFile } from "./chrome-listing-plan";
import { storeMdPath } from "./session-paths";
import { storeScreenshotsDir, storeScreenshotsFolder } from "./store-capture";
import { STORE_MD_FILENAME } from "./store-md";
import { localeSection } from "./store-md-declarations";
import { readText } from "./store-facts-local";
import { parseStoreMdListing } from "./store-md-listing";

import type { ChromeRun, StepDeps, Where } from "./chrome-listing-run";

export type PickerRead = { state: "picker"; value: string } | { state: "all" | "many" | "none" };

const IMAGE = /\.(?:png|jpe?g)$/i;
const DESCRIPTION = CHROME_FIELDS.find((spec) => spec.id === "chrome.description")!.anchors.map((re) => re.source);

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

export function languageNames(tag: string): string[] {
  const nameOf = (locales: string[], options: Intl.DisplayNamesOptions): string => {
    try {
      return new Intl.DisplayNames(locales, options).of(tag) ?? "";
    } catch {
      return "";
    }
  };

  const names = [nameOf(["en"], { type: "language", languageDisplay: "standard" }), nameOf(["en"], { type: "language" }), nameOf([tag], { type: "language", languageDisplay: "standard" })];

  return [...new Set([...names.filter((name) => name && name.toLowerCase() !== tag.toLowerCase()), tag, tag.replace(/-/g, "_")])];
}

const escaped = (raw: string): string => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function readsAs(value: string, tag: string): boolean {
  return languageNames(tag).some((name) => new RegExp(`(?:^|[^\\p{L}])${escaped(name)}(?:$|[^\\p{L}_-])`, "iu").test(value.trim()));
}

export const localesFolder = (tag: string): string => `_locales/${tag.replace(/-/g, "_")}/messages.json`;

export function pendingLanguage(run: Pick<ChromeRun, "plan" | "languages">): ChromeLocale | null {
  return run.plan.locales.find((row) => !run.languages.some((done) => done.locale === row.locale)) ?? null;
}

function named(run: ChromeRun, locale: string, line: string, ok: boolean): void {
  run.languages.push({ locale, line });

  if (!ok) addRow(run, { tab: "any", line });
}

function nameRest(run: ChromeRun, why: (row: ChromeLocale) => string): string {
  for (let row = pendingLanguage(run); row; row = pendingLanguage(run)) named(run, row.locale, why(row), false);

  return "moved";
}

async function pick(deps: StepDeps, tag: string, names: string[]): Promise<{ ok: true; value: string } | { ok: false; why: string }> {
  let why = "";

  for (const name of names) {
    const chosen = await deps.page.call<{ outcome: string; x?: number; y?: number }>("pickLanguage", name);

    if (chosen?.outcome === "filled" || chosen?.outcome === "unchanged") return { ok: true, value: name };
    if (chosen?.outcome === "missing") return { ok: false, why: "no single language picker was found" };
    if (chosen?.outcome === "no-option") why ||= `the list has no option reading "${name}"`;

    if (chosen?.outcome === "open" && typeof chosen.x === "number" && typeof chosen.y === "number") {
      await deps.page.click(chosen.x, chosen.y);
      await deps.sleep(500);

      const at = await deps.page.call<{ x?: number; y?: number; found?: number; seen?: string[] } | null>("option", name);

      if (at && typeof at.x === "number" && typeof at.y === "number") {
        await deps.page.click(at.x, at.y);
        await deps.sleep(800);

        const read = await deps.page.call<PickerRead>("languagePicker");

        if (read?.state === "picker" && readsAs(read.value, tag)) return { ok: true, value: read.value };

        why ||= `"${name}" was picked and the picker still reads "${read?.state === "picker" ? read.value : ""}"`;
      } else {
        const seen = at?.seen ?? [];

        why ||= `the open list shows no option reading "${name}"${seen.length ? ` (it shows ${seen.map((row) => `"${row}"`).join(", ")})` : ""}`;
        await deps.page.click(chosen.x, chosen.y);
        await deps.sleep(300);
      }
    }
  }

  return { ok: false, why: why || "the picker took none of its names" };
}

/* @invariant EVERY STORE.md LANGUAGE GETS A ROW, FILLED OR NAMED. After the
 * default language's Store listing is saved, each language is picked on the
 * page's own language picker, its description and screenshots are set the
 * way the default language's are, and only "Save draft" is pressed. A
 * dashboard showing the listing "For all languages" holds a package with one
 * language, and a picker without the language means the package ships no
 * _locales folder for it: Chrome adds a language only from the package, so
 * each such language is named with the folder it needs, never typed into
 * the default language's fields.
 */
export async function languageStep(run: ChromeRun, deps: StepDeps, where: Where, row: ChromeLocale): Promise<string> {
  if (where.tab !== "listing") {
    const gate = await deps.page.call<{ ok: boolean; x?: number; y?: number }>("gate", "tab:listing");

    if (!gate?.ok || typeof gate.x !== "number" || typeof gate.y !== "number") return nameRest(run, (left) => `${left.locale} on Store listing: the Store listing tab did not open again for this language, so nothing was typed; pick it there and paste its description from ${left.from}`);

    await deps.page.click(gate.x, gate.y);
    await deps.sleep(1500);

    return "moved";
  }

  const picker = await deps.page.call<PickerRead>("languagePicker");

  if (picker?.state === "all") return nameRest(run, (left) => `${left.locale} on Store listing: Chrome shows this item's listing "For all languages", so the package it holds ships one language; Chrome adds ${left.locale} only from ${localesFolder(left.locale)} in the package, so add it, upload a new package and run the fill again`);
  if (picker?.state !== "picker") return nameRest(run, (left) => `${left.locale} on Store listing: ${picker?.state === "many" ? "more than one language picker shows" : "no single language picker was found"}, so nothing was typed; pick ${languageNames(left.locale)[0]} there and paste its description from ${left.from}`);

  run.defaultLanguage ||= picker.value;

  const names = languageNames(row.locale);
  const chosen = await pick(deps, row.locale, names);

  if (!chosen.ok) {
    named(run, row.locale, `${row.locale} on Store listing: the language picker offers no ${names[0]} (${chosen.why}); Chrome lists only the languages the package ships, so add ${localesFolder(row.locale)}, upload a new package and run the fill again`, false);

    return "moved";
  }

  const filled = run.filled.length;
  const rows = run.rows.length;

  if (row.description) await fillText(run, deps, "chrome.description", DESCRIPTION, row.description, "listing", `Description (${row.locale})`);
  if (row.screenshots.length) await attach(run, deps, "screenshots", row.screenshots, `Screenshots (${row.locale})`);

  for (const line of run.rows.slice(rows)) line.tab = "any";

  const gate = await deps.page.call<{ ok: boolean; reason?: string; x?: number; y?: number }>("gate", "save");

  if (gate?.ok && typeof gate.x === "number" && typeof gate.y === "number") await deps.page.click(gate.x, gate.y);

  await deps.sleep(1500);

  const after = await deps.page.call<Where>("where");
  const set = run.filled.slice(filled).map((line) => line.replace(` (${row.locale})`, ""));
  const missing = run.rows.length > rows;
  const shots = row.screenshots.length ? "" : `; it shows the default language's screenshots, since ${row.folder} holds none`;
  const name = row.description ? "" : `; ${row.from} carries no Description, so the default language's shows`;

  if (after?.dialog) {
    named(run, row.locale, `${row.locale} on Store listing: after "Save draft" the dashboard shows "${after.dialog}"; answer it on the page yourself`, false);
    run.stopped = `After "Save draft" for ${row.locale} the dashboard shows "${after.dialog}"; answer it on the page yourself. Nothing else was pressed.`;
    run.line = `Stopped. ${run.stopped}`;

    return "stopped";
  }

  if (!gate?.ok && gate?.reason !== "disabled") {
    named(run, row.locale, `${row.locale} (${chosen.value}) on Store listing: ${set.length ? set.join(", ") : "nothing"} set and "Save draft" was not pressed (${gate?.reason ?? "no answer"}); press it on the page yourself`, false);

    return "moved";
  }

  named(run, row.locale, `${row.locale} (${chosen.value}): ${set.length ? `${set.join(", ")} saved as a draft` : "nothing new to set"}${missing ? ", the rest is in the checklist" : ""}${shots}${name}`, true);
  run.line = `Saved the ${row.locale} listing on Store listing.`;

  return "moved";
}
