// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LISTING_TEXT_LIMITS, type ListingField, type ListingText } from "./store-md-declarations";

export interface SafariUnreadLine {
  line: string;
  reason: string;
}

export const APP_STORE_NAME_OVER =
  (length: number): string =>
    `is ${length} characters, over the ${LISTING_TEXT_LIMITS.appStoreName} the App Store takes; add \`- App Store name:\` under \`## Safari\` with the name the app record keeps`;

/* @invariant THE APP STORE TITLE IS THE RECORD'S NAME, NEVER A NAME OVER
 * APPLE'S LIMIT. The App Store listing's title is the app record's name,
 * global and capped at thirty characters, so the Safari listing's title
 * reads `- App Store name:` first and the shared `- Name:` only when it
 * fits; a longer Name is left out with its length and the limit instead of
 * being pushed, as Leon's 33-character Name was (ledger 160). The sync then
 * takes the record's own name from the platform when no App Store name line
 * is written.
 */
export function safariTitle(
  listing: ListingText,
  skipped: string[],
  unread: Partial<Record<ListingField, SafariUnreadLine>>,
  titleLine: string | undefined,
): void {
  if (listing.appStoreName) {
    listing.title = listing.appStoreName;

    return;
  }

  const title = listing.title;
  if (typeof title !== "string" || title.length <= LISTING_TEXT_LIMITS.appStoreName) return;

  const reason = APP_STORE_NAME_OVER(title.length);
  skipped.push(`title in STORE.md ${reason}, so it was left out`);
  unread.title = { line: `- ${titleLine ?? "Name"}:`, reason };
  delete listing.title;
}
