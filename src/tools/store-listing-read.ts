// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { envelope } from "../lib/envelope";
import {
  isListingStore,
  listingSentence,
  storeListingView,
  type StoreListingView,
} from "../lib/platform-store-listing";
import { projectApiGet, projectApiReadFailure, type ProjectApiRefusal } from "../lib/project-api";
import { consoleProjectUrl } from "../lib/registry";
import { text } from "../lib/ship-act";
import { LISTING_STORES, type ListingStore } from "../lib/store-md-listing";
import { openFor, type Scope } from "./release-history";

const COMMAND = "extension_release_status";

type Row = Record<string, unknown>;

export async function readListing(scope: Scope & { store?: string }): Promise<string> {
  const store = text(scope.store).toLowerCase();

  if (store && !isListingStore(store)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      value: { store },
      error: {
        code: "E_BAD_REQUEST",
        name: "ListingInputError",
        message: `store must be one of ${LISTING_STORES.join(", ")}; got "${store}".`,
      },
    });
  }

  const opened = await openFor(scope, "Listing");
  if (!opened.ok) return opened.out;

  const api = opened.api;
  const where = { workspace: api.ref.workspace, project: api.ref.project };
  const stores: ListingStore[] = store ? [store as ListingStore] : [...LISTING_STORES];
  const reads = await Promise.all(stores.map((name) => projectApiGet<Row>(api, `stores/${name}/listing`)));
  const views: Array<StoreListingView & { consoleUrl: string }> = [];
  const unread: string[] = [];
  let refusal: ProjectApiRefusal | null = null;

  stores.forEach((name, i) => {
    const read = reads[i];

    if (!read.ok) {
      refusal = refusal ?? read;
      unread.push(`${name}: ${read.message}`);

      return;
    }

    views.push({
      ...storeListingView(name, read.json),
      consoleUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.store(name), scope.api),
    });
  });

  if (!views.length && refusal) {
    return projectApiReadFailure(COMMAND, refusal, {
      api: scope.api,
      name: "Listing",
      value: { ...where, ...(store ? { store } : {}) },
      context: { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` },
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      ...where,
      listings: views,
      consoleUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.submissions, scope.api),
    },
    hint: `${views.map(listingSentence).join(". ")}. This is the listing saved on extension.dev, which the platform sends to a store only on publish; extension_submit (action: "sync-listing") fills it from STORE.md and the built icon under an owner's approval, and extension_submit (action: "preflight") says which listing checks still fail.`,
    warnings: [unread.length ? `Listings not read for ${unread.join("; ")}.` : null],
  });
}
