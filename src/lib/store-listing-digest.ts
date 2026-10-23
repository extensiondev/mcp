// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { STORE_FIELDS, type ListingStore } from "./store-md-listing";

import type { ListingPatch } from "./store-listing-media";

export interface ListingDigestView {
  client: string[];
  platform: string[];
  differ: string[];
}

export interface DigestMismatch {
  digest?: ListingDigestView;
  deferred: string[];
}

const UNNAMED_DIGEST_SENTENCE = "The platform did not name the fields it hashes; update the platform or this server.";

function platformFieldsOf(body: unknown): string[] | null {
  const digest = isRow(body) && isRow(body.digest) ? body.digest : null;
  if (!digest || !Array.isArray(digest.platform)) return null;

  const fields = digest.platform.map(text).filter(Boolean);

  return fields.length ? fields : null;
}

/* @invariant ONLY A FIELD THE PATCH CARRIES IS DEFERRED. The digest names
 * every field the two sides declare differently, so the owner can see which
 * build is behind; the deferred list, which the sentence reads out and the
 * retry leaves out, holds only the fields this listing actually sends, so a
 * STORE.md with no review contact email is never told the platform does not
 * take one yet.
 */
export function digestMismatchOf(store: ListingStore, body: unknown, patch?: ListingPatch): DigestMismatch {
  const platform = platformFieldsOf(body);
  if (!platform) return { deferred: [] };

  const client: string[] = STORE_FIELDS[store];
  const clientOnly = client.filter((field) => !platform.includes(field));
  const platformOnly = platform.filter((field) => !client.includes(field));
  const sent = patch ? Object.keys(patch.listing) : null;

  return {
    digest: { client, platform, differ: [...clientOnly, ...platformOnly] },
    deferred: sent ? clientOnly.filter((field) => sent.includes(field)) : clientOnly,
  };
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
  if (!digest) return UNNAMED_DIGEST_SENTENCE;

  const clientOnly = digest.differ.filter((field) => digest.client.includes(field));
  const platformOnly = digest.differ.filter((field) => !digest.client.includes(field));
  const still = afterRetry ? ` even after leaving out ${joined(deferred)}` : "";

  if (digest.differ.length && !platformOnly.length) {
    return `The platform hashes this listing differently from this server${still}: this server declares ${joined(clientOnly)}, which the platform does not hash, so this server is newer than the platform's build. No approval was requested. Say sync-listing again after the platform updates.`;
  }

  const known = platformOnly.length
    ? `the platform hashes ${joined(platformOnly)}, which this server does not know`
    : "both declare the same fields and still disagree on the hash";

  return `The platform hashes this listing differently from this server${still}: ${known}, so the platform is newer than this server. No approval was requested. Update this server to the latest release, then say sync-listing again.`;
}
