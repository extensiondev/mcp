// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { MAX_SCREENSHOTS } from "./store-listing-media";
import {
  BULLET_KEYS,
  LISTING_LIST_LIMITS,
  LISTING_SECTION,
  LISTING_TEXT_LIMITS,
  PRIVACY_SECTION,
  SCREENSHOTS_LINE,
  SEARCH_TERMS_JOINED_LIMITS,
  STORE_FIELDS,
  STORE_OWN_LINES,
  STORE_SECTIONS,
  SUBSECTION_KEYS,
  type ListingField,
  type ListingStore,
  type ListingTextField,
} from "./store-md-declarations";

import type { LocalListing } from "../tools/store-listing";

export type StoreMdField = ListingField | "screenshots";

export interface StoreMdFieldRow {
  field: StoreMdField;
  line: string;
  section: string;
  alsoRead: string[];
  limit: string;
}

export interface StoreMdFieldHome {
  section: string;
  alsoRead: string[];
}

export function storeMdLineOf(field: StoreMdField): string {
  if (field === "screenshots") return `- ${SCREENSHOTS_LINE}:`;

  const bullet = BULLET_KEYS.find((key) => key.field === field);
  if (bullet) return `- ${bullet.line}:`;

  return SUBSECTION_KEYS.find((key) => key.field === field)?.heading ?? `- ${field}:`;
}

/* @invariant THE TABLE IS THE PARSER'S OWN DECLARATION, READ BACK. Every row
 * here is derived from the lists parseStoreMdListing matches against, never
 * typed beside them: the line label from BULLET_KEYS or SUBSECTION_KEYS, the
 * stores from STORE_FIELDS, the limits from LISTING_TEXT_LIMITS and
 * LISTING_LIST_LIMITS, and the section from the same rules the reader
 * applies (a "###" field lives in its store's section, the privacy policy URL
 * in "## Privacy and data use" and is also read under "## Listing" or a
 * store section, the App Store's review contact lines in "## Safari" and
 * also under "## Listing", every other bullet in "## Listing" and also in
 * the store's own section, and "- Category:" and "- Screenshots:" in
 * "## Listing" only). A field the reader learns to take appears here the
 * same hour, and the platform's requirements name the same labels in
 * satisfiedBy "store-md: <line>", so both sides read one table.
 */
export function storeMdSectionOf(field: StoreMdField, store: ListingStore): StoreMdFieldHome {
  if (SUBSECTION_KEYS.some((key) => key.field === field)) return { section: STORE_SECTIONS[store], alsoRead: [] };
  if (field === "privacyPolicyUrl") return { section: PRIVACY_SECTION, alsoRead: [LISTING_SECTION, STORE_SECTIONS[store]] };
  if (field === "categories" || field === "screenshots") return { section: LISTING_SECTION, alsoRead: [] };
  if (STORE_OWN_LINES[store]?.includes(field)) return { section: STORE_SECTIONS[store], alsoRead: [LISTING_SECTION] };

  return { section: LISTING_SECTION, alsoRead: [STORE_SECTIONS[store]] };
}

const count = (n: number): string => n.toLocaleString("en-US");

function limitOf(field: StoreMdField, store: ListingStore): string {
  if (field === "screenshots") return `up to ${MAX_SCREENSHOTS} PNG files inside the project, one path per line below the bullet`;

  if (field === "categories") {
    const limits = LISTING_LIST_LIMITS.categories;

    return `up to ${limits.items} names of ${limits.each} characters each; one name for every store, \`<name> (Chrome), <name> (Firefox)\` per store, or \`<name> (Chrome: <name>, Safari: <name>)\` with the stores that differ`;
  }

  if (field === "searchTerms") {
    const limits = LISTING_LIST_LIMITS.searchTerms;
    const joined = SEARCH_TERMS_JOINED_LIMITS[store];

    return `a comma list, up to ${limits.items} terms of ${limits.each} characters each${joined ? `, ${joined} characters joined by commas` : ""}`;
  }

  if (field === "permissionJustifications") {
    const limits = LISTING_LIST_LIMITS.permissionJustifications;

    return `one \`- <permission>: <reason>\` bullet each, up to ${limits.items}; a permission up to ${limits.permission} characters, a reason up to ${count(limits.justification)}`;
  }

  const chars = `up to ${count(LISTING_TEXT_LIMITS[field as ListingTextField])} characters`;

  if (/Url$/.test(field)) return `an http or https URL, ${chars}`;
  if (field === "supportEmail" || field === "reviewContactEmail") return `an email address, ${chars}`;
  if (field === "reviewContactPhone") return `an E.164 phone number, ${chars}`;
  if (field === "fullDescription") return `paragraphs indented below the bullet, ${chars}`;

  return chars;
}

export function storeMdFieldRows(store: ListingStore): StoreMdFieldRow[] {
  return [...STORE_FIELDS[store], "screenshots" as const].map((field) => ({
    field,
    line: storeMdLineOf(field),
    ...storeMdSectionOf(field, store),
    limit: limitOf(field, store),
  }));
}

export interface StoreMdLineNotFound {
  field: StoreMdField;
  line: string;
  section: string;
}

/* @invariant A MISS IS NAMED BY THE LINE LOOKED FOR, NEVER BY THE FIELD. The
 * sync answers the exact STORE.md lines it read for and did not find, each
 * with the section the table gives it, so the author adds "- Category:"
 * under "## Listing" instead of guessing what "categories" means. A line that
 * is there and could not be taken is already in skipped with its reason and
 * is not repeated here; the screenshots line is listed when neither STORE.md
 * nor the screenshots argument carried a file.
 */
export function linesNotFound(local: LocalListing): StoreMdLineNotFound[] {
  const listing = local.patch.listing as Record<string, unknown>;
  const missing: StoreMdLineNotFound[] = [];

  for (const field of STORE_FIELDS[local.store]) {
    if (listing[field] !== undefined || local.unread[field]) continue;

    missing.push({ field, line: storeMdLineOf(field), section: storeMdSectionOf(field, local.store).section });
  }

  if (!local.patch.screenshots?.length && !local.screenshotsUnread) {
    missing.push({ field: "screenshots", line: storeMdLineOf("screenshots"), section: LISTING_SECTION });
  }

  return missing;
}
