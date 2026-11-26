// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { bounded } from "./store-md-bounded";
import { LOCALE_FIELDS, localeSection, normalizeLocale, type ListingStore, type LocaleField, type LocaleText } from "./store-md-declarations";
import { STORE_MD_FILENAME } from "./store-md";

import type { StoreMdListing } from "./store-md-listing";

export interface ManifestLocaleMessages {
  name?: string;
  description?: string;
}

export interface ManifestLocales {
  defaultLocale: string;
  folder: string;
  messages: Record<string, ManifestLocaleMessages>;
}

export interface LocaleRow {
  locale: string;
  fields: LocaleField[];
  from: string;
}

export interface LocalizedListing {
  sent: boolean;
  rows: LocaleRow[];
  sentence: string;
  skipped: string[];
}

export interface LocalizedRead {
  locales: Record<string, LocaleText>;
  localized?: LocalizedListing;
}

const FIELD_LINES: Record<LocaleField, string> = { title: "Name", shortDescription: "Summary", fullDescription: "Description" };

const joined = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? ""));

function manifestDefaults(manifest: ManifestLocales | null | undefined, written: Record<string, LocaleText>): Array<{ locale: string; text: LocaleText; from: string }> {
  if (!manifest) return [];

  const fallback = normalizeLocale(manifest.defaultLocale);
  const out: Array<{ locale: string; text: LocaleText; from: string }> = [];

  for (const [folder, messages] of Object.entries(manifest.messages)) {
    const locale = normalizeLocale(folder);
    if (!locale || locale === fallback || written[locale] || out.some((row) => row.locale === locale)) continue;

    const text: LocaleText = {
      ...(messages.name ? { title: messages.name } : {}),
      ...(messages.description ? { shortDescription: messages.description } : {}),
    };

    if (Object.keys(text).length) out.push({ locale, text, from: `${manifest.folder}/${folder}/messages.json` });
  }

  return out;
}

function storeSentence(store: ListingStore, rows: LocaleRow[]): string {
  const languages = joined(rows.map((row) => row.locale));
  const sources = joined(rows.map((row) => `\`${row.from}\``));
  const one = rows.length === 1;

  if (store === "firefox") {
    return `For firefox, the ${languages} listing${one ? "" : "s"} (from ${sources}) ${one ? "goes" : "go"} to the add-on on Firefox Add-ons as that language's name, summary and description, with the next listed upload, in the same run as the default language.`;
  }

  if (store === "chrome") {
    return `For chrome, the ${languages} listing${one ? " was" : "s were"} not sent: Google's API takes no localized listing. Chrome Web Store reads each language's name and summary from the package's _locales/<language>/messages.json, and extension_submit {action: "first-submission", store: "chrome"} opens the guided window, which picks each language on Store listing and fills its description from ${sources}, with the screenshots under store/screenshots/chrome/<language>/, and saves the draft.`;
  }

  if (store === "edge") {
    return `For edge, the ${languages} listing${one ? " was" : "s were"} not sent: the Edge Add-ons API takes no listing text. In Partner Center, open Store listings, add the language and paste its name, short description and description from ${sources}.`;
  }

  return `For safari, the ${languages} listing${one ? " was" : "s were"} not sent: the App Store push writes the default language only. Add the localization in App Store Connect and paste it from ${sources}.`;
}

/* @invariant A LANGUAGE A STORE CANNOT TAKE IS NAMED, NEVER DROPPED. Every
 * extra language comes from its "## Listing (<tag>)" section of STORE.md, or,
 * when no section is written for a language the package ships under
 * _locales, from that folder's messages for the manifest's name and
 * description (as Name and Summary). Firefox Add-ons takes each language on
 * the add-on, so those languages ride in the patch; Google's and Microsoft's
 * APIs take no listing text and the App Store push writes one language, so
 * for those stores nothing is sent and the answer names each language and
 * the file its text sits in. A line over a limit is left out with its
 * length, the way the default language's is.
 */
export function localizedListingFor(parsed: StoreMdListing, manifest: ManifestLocales | null | undefined, store: ListingStore): LocalizedRead {
  const written = Object.entries(parsed.locales ?? {}).map(([locale, text]) => ({ locale, text, from: `${localeSection(locale)} in ${STORE_MD_FILENAME}` }));
  const all = [...written, ...manifestDefaults(manifest, parsed.locales ?? {})];
  const locales: Record<string, LocaleText> = {};
  const rows: LocaleRow[] = [];
  const skipped: string[] = [];

  for (const { locale, text, from } of all) {
    const kept: LocaleText = {};

    for (const field of LOCALE_FIELDS) {
      if (text[field] === undefined) continue;

      const read = bounded(field, text[field], skipped, store);

      if ("reason" in read) skipped.push(`${FIELD_LINES[field]} for ${locale} (${from}) ${read.reason}, so it was left out`);
      else if (read.value !== undefined) kept[field] = read.value as string;
    }

    const fields = LOCALE_FIELDS.filter((field) => kept[field] !== undefined);
    if (!fields.length) continue;

    locales[locale] = kept;
    rows.push({ locale, fields, from });
  }

  if (!rows.length) return { locales: {}, ...(skipped.length ? { localized: { sent: false, rows, sentence: "", skipped } } : {}) };

  const sent = store === "firefox";

  return { locales: sent ? locales : {}, localized: { sent, rows, sentence: storeSentence(store, rows), skipped } };
}
