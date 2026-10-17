// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { engineBrowserName } from "./browser-family";
import { engineProjectRoot } from "./session-paths";

type Manifest = Record<string, unknown>;

const ACTION_KEYS = ["action", "browser_action", "page_action"] as const;
const SIDEBAR_KEYS = ["side_panel", "sidebar_action"] as const;

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

function sourceManifest(projectPath: string): Manifest | null {
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

function builtBrowsers(projectPath: string): string[] {
  const dist = path.join(engineProjectRoot(projectPath), "dist");

  try {
    return fs
      .readdirSync(dist, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && readManifest(path.join(dist, entry.name, "manifest.json")))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function manifestByBrowser(projectPath: string): ManifestByBrowser {
  const source = sourceManifest(projectPath);
  const emitted: Record<string, Manifest> = {};
  const resolved: Record<string, ResolvedManifestKeys> = {};
  const sourceDivergence: Record<string, string[]> = {};

  for (const browser of builtBrowsers(projectPath)) {
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
    resolved,
    differences,
    emitted,
    ...(Object.keys(sourceDivergence).length ? { sourceDivergence } : {}),
  };
}
