// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { pngHeader } from "./png-flat";
import { localizedMessage, messageKeyOf } from "./publish-localized-name";
import { listStoreScreenshots } from "./store-capture";
import { codeFactsOf } from "./store-code-facts";
import { readText } from "./store-facts-local";
import { readScreenshots } from "./store-listing-media";
import { LISTING_STORES, type ListingStore } from "./store-md-declarations";
import { parseStoreMdListing } from "./store-md-listing";

import type { DraftFacts, GalleryFacts, ManifestTextRead, ShotsFacts } from "./submit-facts";

type Row = Record<string, unknown>;

function readJson(file: string): Row | null {
  const raw = readText(file);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function manifestText(projectPath: string, key: "name" | "description"): ManifestTextRead | null {
  for (const dir of [path.join(projectPath, "src"), projectPath]) {
    const manifest = readJson(path.join(dir, "manifest.json"));
    if (!manifest) continue;

    const where = path.relative(projectPath, path.join(dir, "manifest.json")).split(path.sep).join("/");
    const raw = text(manifest[key]);
    const message = messageKeyOf(raw);

    if (raw && !message) return { value: raw, from: `${where} ${key}` };
    if (!message) return null;

    const locale = text(manifest.default_locale);
    const file = `_locales/${locale}/messages.json`;
    const localized = locale ? localizedMessage(readJson(path.join(dir, file)), message) : null;

    return localized ? { value: localized, from: `${path.relative(projectPath, path.join(dir, file)).split(path.sep).join("/")} ${message}` } : null;
  }

  return null;
}

function namedOnDisk(projectPath: string, named: readonly string[]): { found: string[]; missing: string[] } {
  const root = (() => {
    try {
      return fs.realpathSync(projectPath);
    } catch {
      return path.resolve(projectPath);
    }
  })();
  const found: string[] = [];
  const missing: string[] = [];

  for (const given of named) {
    try {
      const real = fs.realpathSync(path.resolve(root, given));
      const relative = path.relative(root, real);
      const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);

      (inside && fs.statSync(real).isFile() ? found : missing).push(inside ? relative.split(path.sep).join("/") : given);
    } catch {
      missing.push(given);
    }
  }

  return { found, missing };
}

function headerOf(projectPath: string, file: string): GalleryFacts["headers"][string] {
  try {
    return pngHeader(fs.readFileSync(path.join(projectPath, file)));
  } catch {
    return null;
  }
}

export function galleryFactsOf(projectPath: string, named: readonly string[] = []): GalleryFacts {
  const fromStoreMd = namedOnDisk(projectPath, named);
  const folders: Record<string, string[]> = Object.fromEntries(LISTING_STORES.map((store) => [store, listStoreScreenshots(projectPath, store)]));
  const files = [...new Set([...Object.values(folders).flat(), ...fromStoreMd.found])];
  const headers: GalleryFacts["headers"] = Object.fromEntries(files.map((file) => [file, headerOf(projectPath, file)]));

  return { named: fromStoreMd, folders, headers };
}

function screenshotPathsOf(storeMd: string | null): string[] {
  if (storeMd === null) return [];

  try {
    return parseStoreMdListing(storeMd).screenshotPaths ?? [];
  } catch {
    return [];
  }
}

export function draftFactsOf(projectPath: string, storeMd: string | null): DraftFacts {
  const changelog = ["CHANGELOG.md", "changelog.md"].find((name) => fs.existsSync(path.join(projectPath, name))) ?? null;

  return {
    codeFacts: codeFactsOf(projectPath),
    name: manifestText(projectPath, "name"),
    description: manifestText(projectPath, "description"),
    packageVersion: text(readJson(path.join(projectPath, "package.json"))?.version),
    changelog,
    gallery: galleryFactsOf(projectPath, screenshotPathsOf(storeMd)),
  };
}

export function shotsFactsOf(projectPath: string, asked: ListingStore[], screenshots: unknown): ShotsFacts {
  if (screenshots !== undefined) return { given: readScreenshots(projectPath, screenshots, asked), folders: {} };

  const folders: ShotsFacts["folders"] = Object.fromEntries(
    asked.map((store) => {
      const paths = listStoreScreenshots(projectPath, store);

      return [store, { paths, read: paths.length ? readScreenshots(projectPath, paths, [store]) : null }];
    }),
  );

  return { given: null, folders };
}
