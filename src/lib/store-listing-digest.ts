// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { STORE_FIELDS, type ListingField, type ListingStore } from "./store-md-listing";

import type { ListingPatch } from "./store-listing-media";

export interface ListingDigestView {
  client: string[];
  platform: string[];
  differ: string[];
}

export interface DigestMismatch {
  digest: ListingDigestView;
  deferred: string[];
}

/* @invariant THE LEGACY FIELD SET STANDS IN FOR A PLATFORM THAT CANNOT NAME
 * ITS OWN. Commit 62eb188 added subtitle, searchTerms and reviewContactPhone
 * to the safari set, so this server hashes ten fields where the platform's
 * production build still hashes the seven the previous release declared, and
 * every safari sync-listing was refused with LISTING_DIGEST_MISMATCH before
 * an approval was asked for. A platform that answers digest.platform on the
 * refusal names the fields it hashes itself; a platform built before that
 * answer names nothing, and the set the previous release declared is the
 * only way to find the fields it cannot know. Delete this constant and the
 * fallback that reads it once production www answers digest.platform on
 * every LISTING_DIGEST_MISMATCH refusal (the listing lane in
 * UI_BUGS_TO_FIX.md).
 */
export const LEGACY_LISTING_FIELDS: Record<ListingStore, ListingField[]> = {
  chrome: STORE_FIELDS.chrome,
  firefox: STORE_FIELDS.firefox,
  edge: STORE_FIELDS.edge,
  safari: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl"],
};

function platformFieldsOf(body: unknown): string[] | null {
  const digest = isRow(body) && isRow(body.digest) ? body.digest : null;
  if (!digest || !Array.isArray(digest.platform)) return null;

  const fields = digest.platform.map(text).filter(Boolean);

  return fields.length ? fields : null;
}

export function digestMismatchOf(store: ListingStore, body: unknown): DigestMismatch {
  const client: string[] = STORE_FIELDS[store];
  const platform = platformFieldsOf(body) ?? LEGACY_LISTING_FIELDS[store];
  const clientOnly = client.filter((field) => !platform.includes(field));
  const platformOnly = platform.filter((field) => !client.includes(field));

  return { digest: { client, platform, differ: [...clientOnly, ...platformOnly] }, deferred: clientOnly };
}

export function withoutFields(patch: ListingPatch, deferred: string[]): ListingPatch {
  const listing = Object.fromEntries(Object.entries(patch.listing).filter(([field]) => !deferred.includes(field)));

  return { ...patch, listing };
}

export function joined(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;

  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function deferredSentence(deferred: string[], synced: number, awaiting: boolean): string {
  const state = awaiting ? "in the approval" : "synced";
  const others = synced === 1 ? `the other field is ${state}` : `the other ${synced} fields are ${state}`;

  return `The platform does not take ${joined(deferred)} yet (its build is behind this server); ${others}. Say sync-listing again after the platform updates.`;
}

export function behindSentence(mismatch: DigestMismatch, afterRetry: boolean): string {
  const { digest, deferred } = mismatch;
  const platformOnly = digest.differ.filter((field) => !deferred.includes(field));
  const still = afterRetry ? ` even after leaving out ${joined(deferred)}` : "";

  if (digest.differ.length && !platformOnly.length) {
    return `The platform hashes this listing differently from this server${still}: this server declares ${joined(deferred)}, which the platform does not hash, so this server is newer than the platform's build. No approval was requested. Say sync-listing again after the platform updates.`;
  }

  const known = platformOnly.length
    ? `the platform hashes ${joined(platformOnly)}, which this server does not know`
    : "both declare the same fields and still disagree on the hash";

  return `The platform hashes this listing differently from this server${still}: ${known}, so the platform is newer than this server. No approval was requested. Update this server to the latest release, then say sync-listing again.`;
}
