// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { stageListingImages, stagedPatch } from "./listing-image-stage";

import type { ProjectApi, ProjectApiRefusal } from "./project-api";
import type { ListingDigestPatch, ListingPatch } from "./store-listing-media";
import type { ListingStore } from "./store-md-listing";

export type StageFailure = { out: string } | { refused: ProjectApiRefusal };

export async function checkDigestPatch(api: ProjectApi, store: ListingStore, patch: ListingPatch): Promise<ListingDigestPatch | StageFailure> {
  if (!patch.icons?.length && !patch.screenshots?.length) return patch;

  const staging = await stageListingImages(api, store, patch);

  if ("out" in staging || "refused" in staging) return staging;

  return staging.mode === "staged" ? stagedPatch(patch, staging.images) : patch;
}
