// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { CHROMIUM_FAMILY, GECKO_FAMILY, WEBKIT_FAMILY, engineBrowserName } from "./browser-family";
import { engineProjectRoot } from "./session-paths";

type Manifest = Record<string, unknown>;

const ACTION_KEYS = ["action", "browser_action", "page_action"] as const;
const SIDEBAR_KEYS = ["side_panel", "sidebar_action"] as const;
const ENGINE_SESSION_DIR = "extension-js";
const KNOWN_DIST_BROWSERS: ReadonlySet<string> = new Set(
  [...CHROMIUM_FAMILY, ...GECKO_FAMILY, ...WEBKIT_FAMILY].map(engineBrowserName),
);

export interface ResolvedManifestKeys {
  background: unknown;
  actionKey: string | null;
  sidebarKey: string | null;
  permissions: unknown;
  host_permissions: unknown;
  chrome_url_overrides: unknown;
  browser_specific_settings: unknown;
}

export interface ManifestByBrowser {
  browsers: string[];
  otherFolders: string[];
  resolved: Record<string, ResolvedManifestKeys>;
  differences: string[];
  emitted: Record<string, Manifest>;
  sourceDivergence?: Record<string, string[]>;
}

function readManifest(file: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Manifest) : null;
  } catch {
    return null;
  }
}

export function sourceManifest(projectPath: string): Manifest | null {
  return (
    readManifest(path.resolve(projectPath, "src", "manifest.json")) ??
    readManifest(path.resolve(projectPath, "manifest.json"))
  );
}

function builtManifest(projectPath: string, browser: string): Manifest | null {
  return readManifest(path.join(engineProjectRoot(projectPath), "dist", engineBrowserName(browser), "manifest.json"));
}

function divergenceBetween(source: Manifest, built: Manifest): string[] {
  const notes: string[] = [];
  const listOf = (m: Manifest, key: string): string[] =>
    Array.isArray(m[key]) ? (m[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

  for (const key of ["permissions", "host_permissions", "optional_permissions"]) {
    const lost = listOf(source, key).filter((p) => !listOf(built, key).includes(p));

    if (lost.length) {
      notes.push(
        `The built manifest drops ${key}: ${lost.join(", ")}. The production build has narrower access than the source you tested in dev.`,
      );
    }
  }

  const sourceWar = source.web_accessible_resources;

  if (Array.isArray(sourceWar) && sourceWar.length && !Array.isArray(built.web_accessible_resources)) {
    notes.push(
      "The built manifest has no web_accessible_resources although the source declares them. Anything injected into a page (scripting.insertCSS targets, injected scripts, images) will be blocked at runtime.",
    );
  }

  return notes;
}

export function manifestDivergence(projectPath: string, browser: string): string[] {
  const built = builtManifest(projectPath, browser);
  const source = sourceManifest(projectPath);

  return built && source ? divergenceBetween(source, built) : [];
}

function firstPresent(manifest: Manifest, keys: readonly string[]): string | null {
  return keys.find((key) => manifest[key] !== undefined) ?? null;
}

export function resolvedManifestKeys(manifest: Manifest): ResolvedManifestKeys {
  return {
    background: manifest.background ?? null,
    actionKey: firstPresent(manifest, ACTION_KEYS),
    sidebarKey: firstPresent(manifest, SIDEBAR_KEYS),
    permissions: manifest.permissions ?? null,
    host_permissions: manifest.host_permissions ?? null,
    chrome_url_overrides: manifest.chrome_url_overrides ?? null,
    browser_specific_settings: manifest.browser_specific_settings ?? null,
  };
}

/* @invariant A DIST FOLDER IS A BROWSER ONLY WHEN THE ENGINE COULD HAVE
 * WRITTEN IT. The engine builds into dist/<browser> for the browser names in
 * browser-family.ts (firefox-based is written as gecko-based), so only those
 * names are read as browsers and carry an emitted manifest here; every other
 * folder under dist, a hand copy such as chrome-test-host or a test fixture
 * with its own manifest.json, is listed by name under otherFolders and its
 * manifest is never read, and the engine's own dist/extension-js session
 * folder is neither. On 2026-10-23 chrome-dev-assets, chrome-test-host,
 * chrome-license and firefox-test-host were answered as browsers. */
function distFolders(projectPath: string): { browsers: string[]; otherFolders: string[] } {
  const dist = path.join(engineProjectRoot(projectPath), "dist");

  try {
    const folders = fs
      .readdirSync(dist, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ENGINE_SESSION_DIR)
      .map((entry) => entry.name)
      .sort();

    return {
      browsers: folders.filter(
        (name) => KNOWN_DIST_BROWSERS.has(name) && readManifest(path.join(dist, name, "manifest.json")),
      ),
      otherFolders: folders.filter((name) => !KNOWN_DIST_BROWSERS.has(name)),
    };
  } catch {
    return { browsers: [], otherFolders: [] };
  }
}

export function manifestByBrowser(projectPath: string): ManifestByBrowser {
  const source = sourceManifest(projectPath);
  const emitted: Record<string, Manifest> = {};
  const resolved: Record<string, ResolvedManifestKeys> = {};
  const sourceDivergence: Record<string, string[]> = {};

  const folders = distFolders(projectPath);

  for (const browser of folders.browsers) {
    const manifest = builtManifest(projectPath, browser);
    if (!manifest) continue;

    emitted[browser] = manifest;
    resolved[browser] = resolvedManifestKeys(manifest);

    const notes = source ? divergenceBetween(source, manifest) : [];
    if (notes.length) sourceDivergence[browser] = notes;
  }

  const browsers = Object.keys(emitted);
  const keys = Object.keys(resolvedManifestKeys({})) as Array<keyof ResolvedManifestKeys>;
  const differences = keys.filter(
    (key) => new Set(browsers.map((browser) => JSON.stringify(resolved[browser][key]))).size > 1,
  );

  return {
    browsers,
    otherFolders: folders.otherFolders,
    resolved,
    differences,
    emitted,
    ...(Object.keys(sourceDivergence).length ? { sourceDivergence } : {}),
  };
}
