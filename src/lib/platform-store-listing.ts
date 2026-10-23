// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { LISTING_STORES, type ListingStore } from "./store-md-listing";

export interface StoreListingNotes {
  reviewer?: string;
  release?: string;
  certification?: string;
  privacy?: string;
}

export interface StoreListingText {
  title: string | null;
  summary: string | null;
  description: string | null;
  categories: string[];
  license: string | null;
  supportEmail: string | null;
  homepageUrl: string | null;
  privacyPolicyUrl: string | null;
  privacyPolicyAttested: boolean;
  singlePurpose: string | null;
  searchTerms: string[];
  permissionJustifications: number;
  notes: StoreListingNotes;
}

export interface StoreListingView {
  store: ListingStore;
  updatedAt: string | null;
  listing: StoreListingText;
  media: { icons: number; screenshots: number };
  lacks: string[];
}

export const LISTING_LACKS_ORDER = [
  "title",
  "summary",
  "description",
  "category",
  "license",
  "supportEmail",
  "homepageUrl",
  "privacyPolicyUrl",
  "icon",
  "screenshot",
] as const;

const NOTE_FIELDS: Array<[keyof StoreListingNotes, string]> = [
  ["reviewer", "reviewerNotes"],
  ["release", "releaseNotes"],
  ["certification", "certificationNotes"],
  ["privacy", "privacySection"],
];

export function isListingStore(value: unknown): value is ListingStore {
  return (LISTING_STORES as readonly string[]).includes(String(value));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function orNull(value: unknown): string | null {
  return text(value) || null;
}

/* @invariant THE LISTING IS COPIED BY NAME, NEVER SPREAD. The platform's
 * listing document is a free-form record the console writes, so only the
 * fields named here leave this function, each under the name the STORE.md
 * reader and the sync diff already use (summary, description, category), and
 * an image is answered as a count, never as bytes or a hash.
 */
export function storeListingView(store: ListingStore, raw: unknown): StoreListingView {
  const doc = isRow(raw) ? raw : {};
  const listing = isRow(doc.listing) ? doc.listing : {};
  const media = isRow(doc.media) ? doc.media : {};
  const notes: StoreListingNotes = {};

  for (const [key, field] of NOTE_FIELDS) {
    const value = text(listing[field]);
    if (value) notes[key] = value;
  }

  const view: StoreListingText = {
    title: orNull(listing.title),
    summary: orNull(listing.shortDescription),
    description: orNull(listing.fullDescription),
    categories: strings(listing.categories),
    license: orNull(listing.license),
    supportEmail: orNull(listing.supportEmail),
    homepageUrl: orNull(listing.homepageUrl),
    privacyPolicyUrl: orNull(listing.privacyPolicyUrl),
    privacyPolicyAttested: listing.privacyPolicyAttested === true,
    singlePurpose: orNull(listing.singlePurpose),
    searchTerms: strings(listing.searchTerms),
    permissionJustifications: count(listing.permissionJustifications),
    notes,
  };
  const icons = count(media.icons);
  const screenshots = count(media.screenshots);
  const present: Record<(typeof LISTING_LACKS_ORDER)[number], boolean> = {
    title: Boolean(view.title),
    summary: Boolean(view.summary),
    description: Boolean(view.description),
    category: view.categories.length > 0,
    license: Boolean(view.license),
    supportEmail: Boolean(view.supportEmail),
    homepageUrl: Boolean(view.homepageUrl),
    privacyPolicyUrl: Boolean(view.privacyPolicyUrl),
    icon: icons > 0,
    screenshot: screenshots > 0,
  };

  return {
    store,
    updatedAt: orNull(doc.updatedAt),
    listing: view,
    media: { icons, screenshots },
    lacks: LISTING_LACKS_ORDER.filter((field) => !present[field]),
  };
}

export function listingSentence(view: StoreListingView): string {
  const head = view.listing.title ? `titled "${view.listing.title}"` : "no title yet";
  const media = `${view.media.icons} icon${view.media.icons === 1 ? "" : "s"}, ${view.media.screenshots} screenshot${
    view.media.screenshots === 1 ? "" : "s"
  }`;
  const lacks = view.lacks.length ? `; lacks ${view.lacks.join(", ")}` : "; nothing missing";

  return `${view.store}: ${head}, ${media}${lacks}`;
}
