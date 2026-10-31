// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_MD_FILENAME } from "./store-md";
import { amoCategoriesOf, categoryOrigin, STORE_CATEGORY_NAMES } from "./store-categories";
import { LISTING_SECTION, STORE_SECTIONS } from "./store-md-declarations";

import type { LocalListing } from "../tools/store-listing";

export type FirefoxCategoryCover = { names: string[]; origin: string } | { unread: string };

export function firefoxCategoryCover(local: LocalListing): FirefoxCategoryCover | null {
  const names = local.patch.listing.categories;
  if (!Array.isArray(names) || !names.length) return null;

  const amo = amoCategoriesOf(names);

  if (amo.length) {
    return { names: amo, origin: local.categories ? categoryOrigin("firefox", local.categories) : `from ${LISTING_SECTION.replace(/^## /, "")}` };
  }

  const line = `- ${local.lines.categories ?? "Category"}:`;
  const own = (STORE_CATEGORY_NAMES.firefox ?? []).join(", ");

  return {
    unread: `the \`${line}\` line in ${STORE_MD_FILENAME} names ${names.join(", ")}, which Firefox Add-ons has no category for; put \`- Category: <one of ${own}>\` under \`${STORE_SECTIONS.firefox}\``,
  };
}
