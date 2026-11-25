// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { text } from "./row";
import { screenshotRefusal, type ListingImage } from "./store-listing-media";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { localListingOf } from "./store-listing-local";
import { factOf } from "./submit-facts";
import { readSubmitFacts, type SubmitFactsArgs } from "./submit-facts-local";

type Args = Record<string, unknown>;

const COMMAND = "extension_submit";
const LISTING_ACT = "sync-listing";
const NOTHING_SENT = "Dry run: nothing was written, sent to extension.dev or a store, and no image was staged.";

export const DRY_RUN_HELD_ACTIONS = ["sync-listing", "publish", "review", "cancel", "rollout", "release", "configure-store", "mint-signing"] as const;

const HELD = new Set<string>(DRY_RUN_HELD_ACTIONS);

export const SUBMIT_DRY_RUN_TEXT =
  "Omitted: submit dry runs, other actions run. true sends nothing: sync-listing answers what it would write, other acts run nothing. false submits once approved and stops at the draft under the default modes.";

function imageRow(image: ListingImage): Args {
  return { name: image.source, width: image.width, height: image.height, bytes: image.size };
}

function storesOf(args: Args): string[] {
  const named = Array.isArray(args.browsers) && args.browsers.length ? args.browsers : [text(args.store) || "chrome"];

  return [...new Set(named.map((entry) => text(entry).toLowerCase()))];
}

function refused(message: string): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action: LISTING_ACT, dryRun: true, written: false },
    error: { code: "E_BAD_REQUEST", name: "ListingInputError", message: `${message} ${NOTHING_SENT}` },
    hint: "Fix what the message names, then call sync-listing with dryRun: true again to see the listing it would write.",
  });
}

function listingPreview(args: Args): string {
  const asked = storesOf(args);
  const unknown = asked.filter((store) => !(LISTING_STORES as readonly string[]).includes(store));

  if (unknown.length) return refused(`${unknown.join(", ")} is not a store; use ${LISTING_STORES.join(", ")}.`);

  const facts = readSubmitFacts(args as SubmitFactsArgs).project;

  if (!facts.projectPath || !facts.exists || !facts.shots) return refused("sync-listing needs projectPath, the extension project root that holds STORE.md and the built dist.");

  const given = args.screenshots !== undefined ? facts.shots.given : null;

  if (given && "problem" in given) return refused(`${given.problem}.`);

  const stores: Args = {};

  for (const store of asked as ListingStore[]) {
    const folder = factOf(facts.shots.folders, store)?.read ?? null;
    const read = given ?? folder;

    if (read && "problem" in read) return refused(`${read.problem}.`);

    const screenshots = read?.screenshots ?? [];
    const shotProblem = screenshotRefusal(store, screenshots);
    const local = localListingOf(facts, store, screenshots);

    if ("problem" in local) return refused(local.problem);

    stores[store] = {
      listing: local.patch.listing,
      icon: local.patch.icons?.[0] ? { ...imageRow(local.patch.icons[0]), ...(local.icon ? { from: local.icon.from, file: local.icon.file } : {}) } : null,
      ...(local.iconMissing ? { iconMissing: local.iconMissing } : {}),
      screenshots: screenshots.map(imageRow),
      ...(local.overLimit.length ? { overLimit: local.overLimit } : {}),
      ...(shotProblem ? { screenshotsRefused: shotProblem.message } : {}),
      ...(Object.keys(local.unread).length ? { unread: Object.keys(local.unread) } : {}),
    };
  }

  const said = Object.entries(stores).map(([store, row]) => {
    const view = row as { listing: Args; icon: unknown; screenshots: unknown[] };
    const fields = [...Object.keys(view.listing), ...(view.icon ? ["icon"] : []), ...(view.screenshots.length ? [`${view.screenshots.length} screenshots`] : [])];

    return `${store}: ${fields.length ? fields.join(", ") : "nothing"}`;
  });
  const build = text(args.useBuild) ? ` The write would also take the icon of build ${text(args.useBuild)}, which only extension.dev reads.` : "";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "sync-listing-preview",
    value: { action: LISTING_ACT, dryRun: true, written: false, stores },
    hint: `${NOTHING_SENT} sync-listing would write, read from STORE.md and the local images: ${said.join("; ")}.${build} The platform may still refuse a value or ask a workspace owner's approval for one it derives. To write it, call extension_submit with the same arguments and dryRun omitted.`,
  });
}

function heldAct(action: string): string {
  return envelope({
    ok: true,
    command: COMMAND,
    status: "dry-run-held",
    value: { action, dryRun: true, written: false },
    hint: `${NOTHING_SENT} ${action} with dryRun: true runs nothing. extension_approvals_request {act: "extension_submit", args} with the same arguments asks a workspace owner's approval of it, and extension_submit with dryRun omitted runs it.`,
  });
}

export function submitDryRunAnswer(command: string, args: Args): string | null {
  if (command !== COMMAND || args.dryRun !== true) return null;

  const action = text(args.action) || "submit";
  if (!HELD.has(action)) return null;

  return action === LISTING_ACT ? listingPreview(args) : heldAct(action);
}
