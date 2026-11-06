// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { LISTING_TOO_LARGE_STATUS } from "./listing-body-limit";
import { projectApiSend, type ProjectApi, type ProjectApiRefusal } from "./project-api";
import { isRow, text } from "./ship-act";
import { MAX_SCREENSHOT_MASTER_BYTES, type ListingImage, type ListingPatch } from "./store-listing-media";

import type { ListingStore } from "./store-md-listing";

type Row = Record<string, unknown>;
type ImageKind = "screenshots" | "icons";

export const STAGED_IMAGE_MAX_BYTES = MAX_SCREENSHOT_MASTER_BYTES;
export const STAGED_IMAGES_PER_STORE = 40;
export const IMAGES_DOOR_MISSING_WARNING =
  "The platform has no listing images door yet (it answered 404 or 405), so the screenshots went base64 inside the one listing request as before; that request stays under the 4.5 MB body limit.";

export const IMAGE_NOT_ON_LISTING = "IMAGE_NOT_ON_LISTING";
export const IMAGE_NOT_ON_LISTING_NEXT =
  "The listing named an image the platform no longer holds as staged; call sync-listing again with the same arguments, which stages every image afresh before the listing write.";

const COMMAND = "extension_submit";
const ACT = "sync-listing";
const OLD_PLATFORM = new Set([404, 405]);

const STAGE_NEXT: Record<string, string> = {
  INVALID_LISTING: "fix the file the platform named (a PNG or JPEG at a size the store takes), then call sync-listing again",
  OWNER_REQUIRED: "staging a listing image takes a workspace owner's token; log in as an owner with extension_auth (action: \"login\") and call sync-listing again",
  IMAGE_STAGE_FAILED: "the platform could not store the image; call sync-listing again with the same arguments",
};

export interface StagedImage {
  name: string;
  kind: ImageKind;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
}

export type StageResult =
  | { mode: "staged"; images: StagedImage[] }
  | { mode: "single-body" }
  | { out: string }
  | { refused: ProjectApiRefusal };

const cache = new WeakMap<ListingImage, Map<string, StagedImage>>();

function queue(patch: ListingPatch): Array<{ kind: ImageKind; image: ListingImage }> {
  return [
    ...(patch.icons ?? []).map((image) => ({ kind: "icons" as const, image })),
    ...(patch.screenshots ?? []).map((image) => ({ kind: "screenshots" as const, image })),
  ];
}

export function stagedImageGuard(store: ListingStore, patch: ListingPatch): string | null {
  const images = queue(patch);
  const heavy = images.find(({ image }) => image.bytes.length > STAGED_IMAGE_MAX_BYTES);

  if (images.length <= STAGED_IMAGES_PER_STORE && !heavy) return null;

  const named = heavy?.image ?? images[STAGED_IMAGES_PER_STORE]!.image;
  const message = heavy
    ? `${store}: ${named.source} is ${named.bytes.length} bytes, over the ${STAGED_IMAGE_MAX_BYTES}-byte cap the platform takes for one listing image. Nothing was sent.`
    : `${store}: ${images.length} listing images were given, over the ${STAGED_IMAGES_PER_STORE} the platform stages for one store; ${named.source} is the first past the cap. Nothing was sent.`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: LISTING_TOO_LARGE_STATUS,
    value: {
      action: ACT,
      store,
      listing: {
        image: { name: named.source, bytes: named.bytes.length, width: named.width, height: named.height },
        limitBytes: STAGED_IMAGE_MAX_BYTES,
        maxImages: STAGED_IMAGES_PER_STORE,
        count: images.length,
      },
    },
    error: { code: "E_BAD_REQUEST", name: "ListingTooLarge", message },
    hint: heavy
      ? `Re-export ${named.source} smaller (fewer colors, or a size the store also takes, such as 1280x800), then call sync-listing again.`
      : `Send at most ${STAGED_IMAGES_PER_STORE} images for ${store}, then call sync-listing again.`,
  });
}

function stagedOf(raw: unknown, kind: ImageKind, image: ListingImage): StagedImage | null {
  const answered = isRow(raw) && isRow(raw.image) ? raw.image : null;
  const sha256 = answered ? text(answered.sha256) : "";
  if (!answered || !sha256) return null;

  const width = Number(answered.width) || image.width;
  const height = Number(answered.height) || image.height;
  const bytes = Number(answered.bytes) || image.bytes.length;

  return { name: image.source, kind, sha256, width, height, bytes };
}

function stageRefusal(store: ListingStore, kind: ImageKind, image: ListingImage, sent: ProjectApiRefusal): string {
  const words = (isRow(sent.body) ? text(sent.body.message) : "") || sent.message;
  const code = sent.code || `HTTP_${sent.status}`;
  const next = STAGE_NEXT[code] ?? "call sync-listing again; if it refuses the same way, the platform's words above name the cause";

  return envelope({
    ok: false,
    command: COMMAND,
    status: `${ACT}-refused`,
    value: { action: ACT, store, image: { name: image.source, kind }, platformCode: code, platformStatus: sent.status },
    error: {
      code: code === "INVALID_LISTING" ? "E_BAD_REQUEST" : "E_PLATFORM",
      name: "ListingImageRefused",
      message: `${store}: staging ${image.source} was refused with ${code}${words ? `: ${words}` : ""}. The listing was not written by this call.`,
    },
    hint: `Next: ${next}.`,
  });
}

export async function stageListingImages(api: ProjectApi, store: ListingStore, patch: ListingPatch): Promise<StageResult> {
  const images: StagedImage[] = [];

  for (const { kind, image } of queue(patch)) {
    const known = cache.get(image)?.get(store);

    if (known) {
      images.push(known);
      continue;
    }

    const sent = await projectApiSend<Row>(api, "PUT", `stores/${store}/listing/images`, {
      kind,
      dataBase64: image.bytes.toString("base64"),
    });

    if (!sent.ok && !images.length && OLD_PLATFORM.has(sent.status)) return { mode: "single-body" };
    if (!sent.ok && (sent.held || sent.status === 0)) return { refused: sent };
    if (!sent.ok) return { out: stageRefusal(store, kind, image, sent) };

    const staged = stagedOf(sent.json, kind, image);

    if (!staged) {
      const empty = { ok: false, status: 200, code: "IMAGE_STAGE_FAILED", message: "the answer named no sha256", held: false, body: null } as const;

      return { out: stageRefusal(store, kind, image, empty) };
    }

    cache.set(image, (cache.get(image) ?? new Map()).set(store, staged));
    images.push(staged);
  }

  return { mode: "staged", images };
}

export function stagedWriteBody(patch: ListingPatch, images: StagedImage[]): Record<string, unknown> {
  const view = (kind: ImageKind) =>
    images.filter((image) => image.kind === kind).map(({ sha256, width, height }) => ({ sha256, width, height }));
  const media: Record<string, unknown> = {};
  if (patch.icons) media.icons = view("icons");
  if (patch.screenshots) media.screenshots = view("screenshots");

  return { listing: patch.listing, ...(Object.keys(media).length ? { media } : {}) };
}

export function stagedSentence(store: string, images: StagedImage[]): string {
  const count = images.length;

  return `For ${store}, ${count} image${count === 1 ? " was" : "s were"} staged one per request through the listing images door (${images.map((image) => image.name).join(", ")}), and the listing write named each by the sha the platform answered.`;
}
