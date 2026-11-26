// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LISTING_SECTION, LOCALE_FIELDS, normalizeLocale, type ListingText, type LocaleText } from "./store-md-declarations";

export type LocaleSections = Record<string, LocaleText>;

const LOCALE_HEADING = /^listing\s*\(\s*([^()]+?)\s*\)\s*$/i;
const SECTION = /^## +(.+)$/gm;

export function localeOfHeading(heading: string): string | null {
  return normalizeLocale(LOCALE_HEADING.exec(heading.trim())?.[1] ?? "");
}

export const isLocaleHeading = (heading: string): boolean => localeOfHeading(heading) !== null;

/* @invariant A LANGUAGE'S LISTING IS ITS OWN SECTION AND NEVER THE SHARED
 * ONE. "## Listing (pt-BR)" carries the same Name, Summary and Description
 * keys as "## Listing" for one extra language, named by its BCP 47 tag
 * (pt-BR, de, zh-TW; pt_BR reads the same). It is read apart, by the same
 * reader as "## Listing", so a translated line never replaces the default
 * language's copy, and only the three lines every store translates are
 * taken from it; the first section for a language wins. A parenthetical
 * that is not a language tag leaves the heading what it always was, the
 * shared listing.
 */
export function localeSections(content: string, read: (content: string) => { shared: ListingText }): LocaleSections {
  const out: LocaleSections = {};
  const headings = [...content.matchAll(SECTION)];

  headings.forEach((match, index) => {
    const locale = localeOfHeading(match[1] ?? "");
    if (!locale || out[locale]) return;

    const body = content.slice(match.index! + match[0].length, headings[index + 1]?.index ?? content.length);
    const shared = read(`${LISTING_SECTION}\n${body}`).shared;
    const text = Object.fromEntries(LOCALE_FIELDS.filter((field) => shared[field]).map((field) => [field, shared[field]!])) as LocaleText;

    if (Object.keys(text).length) out[locale] = text;
  });

  return out;
}
