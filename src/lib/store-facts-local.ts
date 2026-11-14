// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readBuiltManifest } from "./project-manifest";
import { isRow, text } from "./row";
import { engineProjectRoot } from "./session-paths";
import { iconFromDist, iconFromSource } from "./store-listing-media";
import { CHROMEWEBSTORE_MD_FILENAME, STORE_MD_FILENAME } from "./store-md";
import { detectPackageManager, firefoxBuildScript, localBuildToolchain } from "./store-md-toolchain";
import { staleSentence, type LocalIcon, type OnboardingFacts, type SafariDescriptionRead, type StoreMdRead, type ToolchainFacts } from "./submit-facts";

import type { ListingStore } from "./store-md-declarations";

type Row = Record<string, unknown>;

const MESSAGE_KEY = /^__MSG_(\w+)__$/;
const PREFIXES = ["", "firefox:", "gecko:"];

interface ManifestRead {
  manifest: Row;
  dir: string;
  from: string;
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function storeMdAt(dir: string): StoreMdRead {
  const file = path.join(dir, STORE_MD_FILENAME);

  return { file, content: readText(file) };
}

export function chromeWebStoreMdText(projectPath: string): string | null {
  const root = projectPath.trim();

  return root ? readText(path.join(root, CHROMEWEBSTORE_MD_FILENAME)) : null;
}

export function gitHead(projectPath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      encoding: "utf8",
    })
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

/* @invariant A LOCAL ICON IS SENT ONLY WHEN IT IS THE SOURCE ICON. The
 * dist folder is whatever the last local build left, so its icon is compared
 * with the icon the source manifest names: equal bytes mean the dist is
 * current and is sent as dist; different bytes mean the dist is older than
 * the source and the icon is withheld with that sentence, never sent as if it
 * were current (ledger 255, three stores kept the old icon). With no dist the
 * source icon itself is sent, since a build copies it as it is; with no
 * source icon to compare against the dist is taken as found.
 */
export function localIcon(projectPath: string, store: ListingStore): LocalIcon {
  const source = iconFromSource(projectPath);
  const dist = iconFromDist(projectPath, store);

  if ("icon" in dist) {
    if ("icon" in source && source.icon.sha256 !== dist.icon.sha256) {
      const stale = { dist: dist.icon.source.split(path.sep).slice(0, 2).join("/"), source: source.icon.source };

      return { missing: staleSentence(stale, null), stale };
    }

    return { icon: dist.icon, origin: { from: "dist", file: dist.icon.source } };
  }

  if ("icon" in source) return { icon: source.icon, origin: { from: "source", file: source.icon.source } };

  return dist;
}

function readJson(file: string): Row | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

    return isRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function manifestRead(projectPath: string): ManifestRead | null {
  const root = engineProjectRoot(projectPath);
  const candidates: Array<[string, string]> = [
    [path.join(root, "dist", "safari", "manifest.json"), "the built dist/safari/manifest.json"],
    [path.join(root, "src", "manifest.json"), "the source src/manifest.json"],
    [path.join(root, "manifest.json"), "the source manifest.json"],
  ];

  for (const [file, from] of candidates) {
    const manifest = readJson(file);
    if (manifest) return { manifest, dir: path.dirname(file), from };
  }

  return null;
}

function localized(value: string, read: ManifestRead): string | null {
  const key = MESSAGE_KEY.exec(value)?.[1];
  if (!key) return value;

  const locale = text(read.manifest.default_locale);
  if (!locale) return null;

  const messages = readJson(path.join(read.dir, "_locales", locale, "messages.json"));
  const entry = messages ? Object.entries(messages).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : null;

  return isRow(entry) && typeof entry.message === "string" ? entry.message : null;
}

export function safariDescriptionOf(projectPath: string): SafariDescriptionRead | null {
  const read = manifestRead(projectPath);
  if (!read) return null;

  const raw = read.manifest["safari:description"] ?? read.manifest.description;
  if (typeof raw !== "string") return null;

  const description = localized(raw.trim(), read);

  return description === null ? null : { description, from: read.from };
}

function prefixed(row: unknown, key: string): unknown {
  if (!isRow(row)) return undefined;

  return PREFIXES.map((prefix) => row[`${prefix}${key}`]).find((value) => value !== undefined);
}

export function manifestUpdateUrlOf(projectPath: string): string | null {
  if (!text(projectPath)) return null;

  const manifest = readBuiltManifest(projectPath, "firefox")?.manifest;
  const settings = prefixed(manifest, "browser_specific_settings") ?? prefixed(manifest, "applications");
  const url = prefixed(prefixed(settings, "gecko"), "update_url");

  return typeof url === "string" && url.trim() ? url.trim() : null;
}

export function toolchainFactsOf(projectPath: string): ToolchainFacts {
  return {
    localBuild: localBuildToolchain(projectPath),
    packageManager: detectPackageManager(projectPath),
    firefoxBuildScript: firefoxBuildScript(projectPath),
  };
}

export function onboardingFactsOf(projectPath: string): OnboardingFacts {
  let pkg: Row = {};

  try {
    const parsed: unknown = JSON.parse(readText(path.join(projectPath, "package.json")) ?? "{}");
    if (isRow(parsed)) pkg = parsed;
  } catch {
    pkg = {};
  }

  const privacyFile = ["PRIVACY.md", "privacy.md", "PRIVACY"].find((name) => fs.existsSync(path.join(projectPath, name))) ?? null;
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].some((name) => fs.existsSync(path.join(projectPath, name)));

  return { pkg, privacyFile, licenseFile };
}
