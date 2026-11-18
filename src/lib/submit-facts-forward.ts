// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { openProjectApi, projectApiSend, type ProjectApi } from "./project-api";
import { IMAGE_BYTES_NOT_SENT } from "./listing-image-stage";
import { isRow, text } from "./row";
import { screenshotRefusal, type ListingImage, type StageRead } from "./store-listing-media";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { factOf, storeMdFileOf, type SubmitFacts } from "./submit-facts";
import { readSubmitFacts, storeMdFileFact, type SubmitFactsArgs } from "./submit-facts-local";

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

export interface WantedImage {
  store: string;
  kind: string;
  name: string;
}

async function stageImages(facts: SubmitFacts, stores: ListingStore[], stage: StageImage, wanted: WantedImage[]): Promise<void> {
  for (const store of stores) {
    for (const { kind, image } of queueFor(facts, store)) {
      if (wanted.length && !wanted.some((entry) => entry.store === store && entry.kind === kind && entry.name === image.source)) continue;

      const read = await stage(store, kind, image);
      image.staged = { ...image.staged, [store]: read };

      if (!read.ok) break;
    }
  }
}

/* @invariant AN IMAGE IS UPLOADED ONLY AFTER THE LANE HAS JUDGED THE CALL.
 * The first send of a sync-listing carries digests and sizes and no upload,
 * so a call the lane refuses (a STORE.md line over its limit, a plain
 * listing asked through the check tool, a build icon that replaces the
 * local one) has staged nothing. When the lane answers that it holds no
 * bytes for an image, it names the ones its write would send, and only
 * those are uploaded before the call is sent again; a lane that names none
 * gets every image the stores asked would take.
 */
export function imagesTheLaneWants(body: unknown): WantedImage[] | null {
  const value = isRow(body) && isRow(body.value) ? body.value : null;
  if (!value || value.platformCode !== IMAGE_BYTES_NOT_SENT) return null;

  const named = Array.isArray(value.stageFirst) ? value.stageFirst.filter(isRow) : [];

  return named.map((entry) => ({ store: text(entry.store), kind: text(entry.kind), name: text(entry.name) })).filter((entry) => entry.store && entry.kind && entry.name);
}

function withoutBytes(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return null;
  if (Array.isArray(value)) return value.map(withoutBytes);
  if (isRow(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutBytes(entry)]));

  return value;
}

/* @invariant THE FACTS THAT CROSS THE LANE HOLD NO IMAGE BYTES AND NO MACHINE
 * PATH. With sync-listing the icon and screenshots the lane asked for are
 * uploaded from here straight to the platform's listing images door, with the
 * stored login, and each image crosses the lane as its digest, its size and
 * the door's own answer; an image the hosted half would refuse before staging
 * is not uploaded. The project root crosses as a label, STORE.md crosses as
 * where it was read relative to that root, and every lane answer that names
 * the label is read back with the real root, so a sentence still names the
 * file on this machine.
 */
export async function forwardSubmitFacts(args: ForwardFactsArgs, staging: { wanted: WantedImage[]; stage?: StageImage } | null = null): Promise<SubmitFacts> {
  const facts = readSubmitFacts(args);
  const stores = staging && args.action === "sync-listing" && facts.project.exists && facts.project.shots ? listingStores(args) : [];

  if (staging && stores.some((store) => queueFor(facts, store).length)) {
    const opened = staging.stage ? null : await openProjectApi({ command: COMMAND, project: text(args.project) || undefined, api: text(args.api) || undefined });
    const door = staging.stage ?? (opened?.ok ? doorOf(opened.api) : null);

    if (door) await stageImages(facts, stores, door, staging.wanted);
  }

  const sent = withoutBytes(facts) as SubmitFacts;

  return {
    project: { ...sent.project, projectPath: sent.project.projectPath ? PROJECT_PATH_LABEL : "" },
    warningsStoreMd: { ...sent.warningsStoreMd, file: sent.warningsStoreMd.file ? storeMdFileOf({ projectPath: PROJECT_PATH_LABEL, storeMdFile: storeMdFileFact(text(args.projectPath) || process.cwd()) }) : "" },
  };
}

export function labeledScreenshots(args: ForwardFactsArgs): unknown {
  const root = text(args.projectPath);
  if (!root || !Array.isArray(args.screenshots)) return args.screenshots;

  return args.screenshots.map((entry) => (typeof entry === "string" && path.isAbsolute(entry.trim()) ? path.relative(path.resolve(root), entry.trim()).split(path.sep).join("/") : entry));
}

export function withProjectRoot(value: unknown, projectPath: unknown): unknown {
  const root = text(projectPath) || process.cwd();

  if (typeof value === "string") return value.replace(LABELED, (_all, tail: string) => (tail.includes("/../") ? path.normalize(root + tail) : root + tail.split("/").join(path.sep)));
  if (Array.isArray(value)) return value.map((entry) => withProjectRoot(entry, projectPath));
  if (isRow(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withProjectRoot(entry, projectPath)]));

  return value;
}
