// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { StoreListingRead } from "./store-md-listing";

export type ChromeVisibility = "public" | "unlisted" | "private";

const VISIBILITY_REASON = "is not public, unlisted or private, the three visibilities the Chrome Web Store dashboard offers";

export function chromeVisibilityOf(value: string): ChromeVisibility | null {
  const raw = value.trim().toLowerCase();

  if (/^public\b/.test(raw)) return "public";
  if (/^unlisted\b/.test(raw)) return "unlisted";
  if (/^(private|trusted testers?|testers?)\b/.test(raw)) return "private";

  return null;
}

export function chromeVisibilityRead(value: string): { value: ChromeVisibility } | { reason: string } {
  const visibility = chromeVisibilityOf(value);

  return visibility ? { value: visibility } : { reason: VISIBILITY_REASON };
}

/* @invariant THE VISIBILITY SENT IS ONE OF THE DASHBOARD'S THREE WORDS. The
 * Chrome Web Store's Distribution tab offers Public, Unlisted and Private
 * (trusted testers), so `- Visibility:` is read as exactly one of public,
 * unlisted or private, a trailing note allowed ("Unlisted (the default)").
 * Any other value is left out of the listing, named in skipped, and answered
 * as an unread line with the reason, so the platform never stores a word
 * its visibility check cannot compare.
 */
export function withChromeVisibility(read: StoreListingRead, line?: string): StoreListingRead {
  const raw = read.listing.visibility;
  if (raw === undefined) return read;

  const parsed = chromeVisibilityRead(raw);
  if ("value" in parsed) return { ...read, listing: { ...read.listing, visibility: parsed.value } };

  const listing = { ...read.listing };
  delete listing.visibility;

  return {
    listing,
    skipped: [...read.skipped, `visibility in STORE.md ${parsed.reason}, so it was left out`],
    unread: { ...read.unread, visibility: { line: `- ${line ?? "Visibility"}:`, reason: parsed.reason } },
  };
}
