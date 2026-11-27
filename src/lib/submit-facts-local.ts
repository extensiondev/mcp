// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { clientProjectDir } from "./client-roots";
import { firefoxManifestOf } from "./firefox-enterprise";
import { text } from "./row";
import { draftFactsOf, shotsFactsOf } from "./store-draft-facts-local";
import {
  chromeManifestRequestsOf,
  chromeWebStoreMdText,
  gitHead,
  localIcon,
  manifestLocalesOf,
  manifestUpdateUrlOf,
  onboardingFactsOf,
  readText,
  safariDescriptionOf,
  storeMdAt,
  toolchainFactsOf,
} from "./store-facts-local";
import { storeMdPath, storeMdRepositoryNote } from "./session-paths";
import { STORE_MD_FILENAME } from "./store-md";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { emptyProjectFacts, type ProjectFacts, type StoreMdRead, type SubmitFacts } from "./submit-facts";
import { localListingOf } from "./store-listing-local";

import type { ListingImage } from "./store-listing-media";

const STORES = ["chrome", "firefox", "edge", "safari"];
const READ_ACTIONS = new Set(["submit", "preflight", "sync-listing"]);
const UNREAD: StoreMdRead = { file: "", content: null };

export function storeMdFileFact(projectPath: string): string {
  return path.relative(path.resolve(projectPath), storeMdPath(projectPath)).split(path.sep).join("/");
}

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
  const storeMd = readText(storeMdPath(projectPath));
  const preflight = action === "preflight";
  const listing = action === "sync-listing" ? listingStoresOf(asked) : null;

  return {
    projectPath,
    exists,
    storeMd,
    storeMdFile: storeMdFileFact(projectPath),
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
    manifestLocales: action === "sync-listing" && exists ? manifestLocalesOf(projectPath) : null,
    manifestRequests: action === "sync-listing" && exists ? chromeManifestRequestsOf(projectPath) : null,
  };
}

/* @invariant AN ANSWER BUILT ON THE REPOSITORY'S STORE.md SAYS SO. Submit,
 * preflight and sync-listing send the text of the file found to the
 * platform. When that file sits at the repository root and not in the
 * project's own folder, the answer carries the one sentence that names it,
 * so nobody learns from a store listing which file was read.
 */
export function storeMdSourceNote(args: SubmitFactsArgs): string | null {
  const projectPath = text(args.projectPath);
  const action = args.action === undefined ? "submit" : args.action;

  return projectPath && READ_ACTIONS.has(action) ? storeMdRepositoryNote(projectPath) : null;
}

const SUBMIT_COMMANDS = new Set(["extension_submit", "extension_submit_check"]);
const clientFilled = new WeakSet<object>();

export function withClientProjectPath<T extends Record<string, unknown>>(command: string, args: T): T {
  if (!SUBMIT_COMMANDS.has(command) || text(args.action) !== "sync-listing" || text(args.projectPath)) return args;

  const dir = clientProjectDir();
  if (!dir || !fs.existsSync(path.join(dir, STORE_MD_FILENAME))) return args;

  const filled = { ...args, projectPath: dir };
  clientFilled.add(filled);

  return filled;
}

export function clientProjectPathNote(args: object): string | null {
  return clientFilled.has(args) ? `projectPath was omitted, so sync-listing read the client's directory ${text((args as SubmitFactsArgs).projectPath)}, which holds ${STORE_MD_FILENAME}.` : null;
}

export function noClientStoreMdNote(): string {
  const dir = clientProjectDir();

  return dir ? ` The client's directory ${dir} holds no ${STORE_MD_FILENAME} either.` : "";
}

export function readSubmitFacts(args: SubmitFactsArgs): SubmitFacts {
  const action = args.action === undefined ? "submit" : args.action;
  const warningsStoreMd = action === "submit" ? storeMdAt(path.dirname(storeMdPath(String(args.projectPath || "").trim() || process.cwd()))) : UNREAD;

  return { project: readProjectFacts(args, action), warningsStoreMd };
}

export function readLocalListing(projectPath: string, store: ListingStore, screenshots?: ListingImage[]): ReturnType<typeof localListingOf> {
  return localListingOf(
    {
      projectPath: path.resolve(projectPath),
      storeMdFile: storeMdFileFact(projectPath),
      storeMd: readText(storeMdPath(projectPath)),
      chromeWebStoreMd: chromeWebStoreMdText(projectPath),
      icons: { [store]: localIcon(projectPath, store) },
      manifestLocales: manifestLocalesOf(projectPath),
      manifestRequests: chromeManifestRequestsOf(projectPath),
    },
    store,
    screenshots,
  );
}
