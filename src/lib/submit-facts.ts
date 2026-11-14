// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { FirefoxManifestRead } from "./firefox-enterprise";
import type { PngHeader } from "./png-flat";
import type { CodeFacts } from "./store-code-facts";
import type { ListingImage } from "./store-listing-media";
import type { BuiltToolchain } from "./store-md-toolchain";

type Row = Record<string, unknown>;

export type IconOrigin =
  | { from: "build"; build: string; file: string }
  | { from: "dist"; file: string }
  | { from: "source"; file: string };

export interface IconPick {
  icon: ListingImage;
  origin: IconOrigin;
}

export interface IconStale {
  dist: string;
  source: string;
}

export type LocalIcon = IconPick | { missing: string; stale?: IconStale };

export function staleSentence(stale: IconStale, newestBuild: string | null): string {
  const take = newestBuild
    ? `run a build or pass useBuild: "${newestBuild}" to take the icon from build ${newestBuild}`
    : "run a build first (extension_build), or push the commit so the platform builds it";

  return `${stale.dist} is older than ${stale.source}; ${take}`;
}

export interface StoreMdRead {
  file: string;
  content: string | null;
}

export interface SafariDescriptionRead {
  description: string;
  from: string;
}

export interface ToolchainFacts {
  localBuild: BuiltToolchain | null;
  packageManager: string;
  firefoxBuildScript: string | null;
}

export interface OnboardingFacts {
  pkg: Row;
  privacyFile: string | null;
  licenseFile: boolean;
}

export interface ManifestTextRead {
  value: string;
  from: string;
}

export interface GalleryFacts {
  named: { found: string[]; missing: string[] };
  folders: Record<string, string[]>;
  headers: Record<string, PngHeader | null>;
}

export interface DraftFacts {
  codeFacts: CodeFacts;
  name: ManifestTextRead | null;
  description: ManifestTextRead | null;
  packageVersion: string;
  changelog: string | null;
  gallery: GalleryFacts;
}

export type ScreenshotsRead = { screenshots: ListingImage[] } | { problem: string };

export interface ShotsFacts {
  given: ScreenshotsRead | null;
  folders: Record<string, { paths: string[]; read: ScreenshotsRead | null }>;
}

export interface ProjectFacts {
  projectPath: string;
  exists: boolean;
  storeMd: string | null;
  chromeWebStoreMd: string | null;
  gitHead: string;
  icons: Record<string, LocalIcon>;
  safariDescription: SafariDescriptionRead | null;
  firefoxManifest: FirefoxManifestRead | null;
  firefoxUpdateUrl: string | null;
  toolchain: ToolchainFacts | null;
  onboarding: OnboardingFacts;
  draft: DraftFacts | null;
  shots: ShotsFacts | null;
}

export interface SubmitFacts {
  project: ProjectFacts;
  warningsStoreMd: StoreMdRead;
}

export function emptyProjectFacts(projectPath = ""): ProjectFacts {
  return {
    projectPath,
    exists: false,
    storeMd: null,
    chromeWebStoreMd: null,
    gitHead: "",
    icons: {},
    safariDescription: null,
    firefoxManifest: null,
    firefoxUpdateUrl: null,
    toolchain: null,
    onboarding: { pkg: {}, privacyFile: null, licenseFile: false },
    draft: null,
    shots: null,
  };
}

export function factOf<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
