// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { openProjectApi, projectApiSend, type ProjectApi } from "./project-api";
import { isRow, text } from "./row";
import { screenshotRefusal, type ListingImage, type StageRead } from "./store-listing-media";
import { STORE_MD_FILENAME } from "./store-md";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { factOf, type SubmitFacts } from "./submit-facts";
import { readSubmitFacts, type SubmitFactsArgs } from "./submit-facts-local";

type Kind = "icons" | "screenshots";

export const PROJECT_PATH_LABEL = "{projectPath}";

const COMMAND = "extension_submit";
const LABELED = /\{projectPath\}((?:\/[\w.@+-]+)*)/g;

export interface ForwardFactsArgs extends SubmitFactsArgs {
  project?: unknown;
  api?: unknown;
}

export type StageImage = (store: ListingStore, kind: Kind, image: ListingImage) => Promise<StageRead>;

function listingStores(args: SubmitFactsArgs): ListingStore[] {
  const named = Array.isArray(args.browsers) && args.browsers.length ? args.browsers : [text(args.store) || "chrome"];
  const asked = [...new Set(named.map((entry) => text(entry).toLowerCase()))];

  return asked.every((store) => (LISTING_STORES as readonly string[]).includes(store)) ? (asked as ListingStore[]) : [];
}

function queueFor(facts: SubmitFacts, store: ListingStore): Array<{ kind: Kind; image: ListingImage }> {
  const shots = facts.project.shots;
  const read = shots?.given ?? factOf(shots?.folders ?? {}, store)?.read ?? null;
  const screenshots = read && "screenshots" in read ? read.screenshots : [];
  const icon = factOf(facts.project.icons, store);

  if (shots?.given && "problem" in shots.given) return [];
  if (screenshotRefusal(store, screenshots)) return [];

  return [...(icon && "icon" in icon ? [{ kind: "icons" as const, image: icon.icon }] : []), ...screenshots.map((image) => ({ kind: "screenshots" as const, image }))];
}

function doorOf(api: ProjectApi): StageImage {
  return (store, kind, image) => projectApiSend(api, "PUT", `stores/${store}/listing/images`, { kind, dataBase64: (image.bytes ?? Buffer.alloc(0)).toString("base64") });
}

async function stageImages(facts: SubmitFacts, stores: ListingStore[], stage: StageImage): Promise<void> {
  for (const store of stores) {
    for (const { kind, image } of queueFor(facts, store)) {
      const read = await stage(store, kind, image);
      image.staged = { ...image.staged, [store]: read };

      if (!read.ok) break;
    }
  }
}

function withoutBytes(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return null;
  if (Array.isArray(value)) return value.map(withoutBytes);
  if (isRow(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutBytes(entry)]));

  return value;
}

/* @invariant THE FACTS THAT CROSS THE LANE HOLD NO IMAGE BYTES AND NO MACHINE
 * PATH. With sync-listing the icon and screenshots of each store asked are
 * uploaded from here straight to the platform's listing images door, with the
 * stored login, and each image crosses the lane as its digest, its size and
 * the door's own answer; an image the hosted half would refuse before staging
 * is not uploaded. The project root crosses as a label, and every lane answer
 * that names the label is read back with the real root, so a sentence still
 * names the file on this machine.
 */
export async function forwardSubmitFacts(args: ForwardFactsArgs, stage?: StageImage): Promise<SubmitFacts> {
  const facts = readSubmitFacts(args);
  const stores = args.action === "sync-listing" && facts.project.exists && facts.project.shots ? listingStores(args) : [];

  if (stores.some((store) => queueFor(facts, store).length)) {
    const opened = stage ? null : await openProjectApi({ command: COMMAND, project: text(args.project) || undefined, api: text(args.api) || undefined });
    const door = stage ?? (opened?.ok ? doorOf(opened.api) : null);

    if (door) await stageImages(facts, stores, door);
  }

  const sent = withoutBytes(facts) as SubmitFacts;

  return {
    project: { ...sent.project, projectPath: sent.project.projectPath ? PROJECT_PATH_LABEL : "" },
    warningsStoreMd: { ...sent.warningsStoreMd, file: sent.warningsStoreMd.file ? `${PROJECT_PATH_LABEL}/${STORE_MD_FILENAME}` : "" },
  };
}

export function labeledScreenshots(args: ForwardFactsArgs): unknown {
  const root = text(args.projectPath);
  if (!root || !Array.isArray(args.screenshots)) return args.screenshots;

  return args.screenshots.map((entry) => (typeof entry === "string" && path.isAbsolute(entry.trim()) ? path.relative(path.resolve(root), entry.trim()).split(path.sep).join("/") : entry));
}

export function withProjectRoot(value: unknown, projectPath: unknown): unknown {
  const root = text(projectPath) || process.cwd();

  if (typeof value === "string") return value.replace(LABELED, (_all, tail: string) => root + tail.split("/").join(path.sep));
  if (Array.isArray(value)) return value.map((entry) => withProjectRoot(entry, projectPath));
  if (isRow(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withProjectRoot(entry, projectPath)]));

  return value;
}
