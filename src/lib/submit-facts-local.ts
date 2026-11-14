// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { firefoxManifestOf } from "./firefox-enterprise";
import { text } from "./row";
import { draftFactsOf, shotsFactsOf } from "./store-draft-facts-local";
import {
  chromeWebStoreMdText,
  gitHead,
  localIcon,
  manifestUpdateUrlOf,
  onboardingFactsOf,
  readText,
  safariDescriptionOf,
  storeMdAt,
  toolchainFactsOf,
} from "./store-facts-local";
import { STORE_MD_FILENAME } from "./store-md";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { emptyProjectFacts, type ProjectFacts, type StoreMdRead, type SubmitFacts } from "./submit-facts";
import { localListingOf } from "../tools/store-listing";

import type { ListingImage } from "./store-listing-media";

const STORES = ["chrome", "firefox", "edge", "safari"];
const READ_ACTIONS = new Set(["submit", "preflight", "sync-listing"]);
const UNREAD: StoreMdRead = { file: "", content: null };

export interface SubmitFactsArgs {
  action?: string;
  store?: string;
  browsers?: unknown;
  projectPath?: unknown;
  screenshots?: unknown;
}

function askedOf(args: SubmitFactsArgs): string[] {
  const named = Array.isArray(args.browsers) && args.browsers.length ? args.browsers : [text(args.store) || "chrome"];

  return named.map((entry) => text(entry).toLowerCase());
}

function browsersOf(args: SubmitFactsArgs): string[] {
  return (Array.isArray(args.browsers) ? args.browsers : []).map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

function listingStoresOf(asked: string[]): ListingStore[] | null {
  return asked.every((store) => (LISTING_STORES as readonly string[]).includes(store)) ? (asked as ListingStore[]) : null;
}

function readProjectFacts(args: SubmitFactsArgs, action: string): ProjectFacts {
  const projectPath = text(args.projectPath);
  if (!projectPath || !READ_ACTIONS.has(action)) return emptyProjectFacts(projectPath);

  const asked = askedOf(args);
  const stores = [...new Set([...STORES, ...browsersOf(args), ...asked])];
  const exists = fs.existsSync(projectPath);
  const storeMd = readText(path.join(projectPath, STORE_MD_FILENAME));
  const preflight = action === "preflight";
  const listing = action === "sync-listing" ? listingStoresOf(asked) : null;

  return {
    projectPath,
    exists,
    storeMd,
    chromeWebStoreMd: chromeWebStoreMdText(projectPath),
    gitHead: action === "submit" ? "" : gitHead(projectPath),
    icons: Object.fromEntries(stores.map((store) => [store, localIcon(projectPath, store as ListingStore)])),
    safariDescription: listing ? null : safariDescriptionOf(projectPath),
    firefoxManifest: preflight ? firefoxManifestOf(projectPath) : null,
    firefoxUpdateUrl: preflight ? manifestUpdateUrlOf(projectPath) : null,
    toolchain: listing ? null : toolchainFactsOf(projectPath),
    onboarding: preflight ? onboardingFactsOf(projectPath) : emptyProjectFacts().onboarding,
    draft: preflight && exists ? draftFactsOf(projectPath, storeMd) : null,
    shots: listing && exists ? shotsFactsOf(projectPath, listing, args.screenshots) : null,
  };
}

export function readSubmitFacts(args: SubmitFactsArgs): SubmitFacts {
  const action = args.action === undefined ? "submit" : args.action;
  const warningsStoreMd = action === "submit" ? storeMdAt(String(args.projectPath || "").trim() || process.cwd()) : UNREAD;

  return { project: readProjectFacts(args, action), warningsStoreMd };
}

export function readLocalListing(projectPath: string, store: ListingStore, screenshots?: ListingImage[]): ReturnType<typeof localListingOf> {
  return localListingOf(
    {
      projectPath,
      storeMd: readText(path.join(projectPath, STORE_MD_FILENAME)),
      chromeWebStoreMd: chromeWebStoreMdText(projectPath),
      icons: { [store]: localIcon(projectPath, store) },
    },
    store,
    screenshots,
  );
}
