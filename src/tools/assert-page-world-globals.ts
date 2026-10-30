// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { engineManifestView } from "../lib/engine-manifest-view";
import { sourceManifest } from "../lib/manifest-by-browser";

export const BUNDLE_BYTE_CAP = 5 * 1024 * 1024;

const ENGINE_GLOBAL_PREFIXES = ["__extensionjs", "__extjs"];
const SHORT_NAME_LIMIT = 3;

export interface EngineGlobal {
  name: string;
  file?: string;
  devRuntime?: true;
}

export interface BuiltGlobal {
  name: string;
  file: string;
  devRuntime?: true;
}

export interface SkippedBundle {
  file: string;
  reason: string;
}

export interface BundleRead {
  searched: string[];
  skipped: SkippedBundle[];
  note?: string;
}

export interface ExtensionGlobals {
  engine: EngineGlobal[];
  built: BuiltGlobal[];
  bundles: BundleRead;
  unexplained: string[] | null;
}

export function isEngineGlobal(name: string): boolean {
  const lower = name.toLowerCase();

  return ENGINE_GLOBAL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function mainWorldScripts(manifest: Record<string, unknown>): string[] {
  const raw = manifest.content_scripts;
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;

    const block = entry as Record<string, unknown>;
    if (block.world !== "MAIN") continue;

    const scripts = Array.isArray(block.js) ? block.js.map(String) : [];

    for (const script of scripts) {
      const relative = script.replace(/^\/+/, "");
      if (relative && !out.includes(relative)) out.push(relative);
    }
  }

  return out;
}

export function devRewrittenScripts(projectPath: string, browser: string): string[] {
  const source = sourceManifest(projectPath);

  return source ? mainWorldScripts(engineManifestView(source, browser)) : [];
}

function rewrittenNote(rewritten: string[]): string {
  const count = rewritten.length;

  return `The dev build rewrites the ${count} world: MAIN content ${count === 1 ? "script" : "scripts"} of the source manifest (${rewritten.join(", ")}) into isolated loaders, so no built bundle was searched; their globals are judged on an extension_start session`;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function namesGlobal(text: string, name: string): boolean {
  const id = escapeForRegExp(name);
  const edge = "(?![\\w$])";
  const forms = [`(?:window|globalThis|self)\\.${id}${edge}`];

  if (name.length >= SHORT_NAME_LIMIT) {
    forms.push(`(?<![\\w$.])${id}\\s*=(?!=)`, `["'\`]${id}["'\`]`);
  }

  return new RegExp(forms.join("|")).test(text);
}

function readBundle(distDir: string, relative: string, skipped: SkippedBundle[]): string | null {
  const file = path.resolve(distDir, relative);

  if (!file.startsWith(distDir + path.sep)) {
    skipped.push({ file: relative, reason: `${relative} resolves outside ${distDir}, so it was not read` });

    return null;
  }

  let size: number;

  try {
    size = fs.statSync(file).size;
  } catch {
    skipped.push({ file: relative, reason: `${relative} is not a file under ${distDir}, so it was not read` });

    return null;
  }

  if (size > BUNDLE_BYTE_CAP) {
    skipped.push({
      file: relative,
      reason: `${relative} is ${size.toLocaleString("en-US")} bytes, over the ${BUNDLE_BYTE_CAP.toLocaleString("en-US")} byte cap, so it was not searched`,
    });

    return null;
  }

  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    skipped.push({
      file: relative,
      reason: `${relative} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });

    return null;
  }
}

export function searchBundles(
  manifest: Record<string, unknown>,
  distDir: string | null,
  names: string[],
  rewritten: string[] = [],
): { hits: Array<{ name: string; file: string }>; bundles: BundleRead } {
  const hits: Array<{ name: string; file: string }> = [];
  const bundles: BundleRead = { searched: [], skipped: [] };

  if (distDir === null) {
    bundles.note =
      "The built MAIN-world bundles were not searched for the unknown globals because the running manifest is the source one, not a build";

    return { hits, bundles };
  }

  const files = mainWorldScripts(manifest);

  if (files.length === 0) {
    bundles.note = rewritten.length
      ? rewrittenNote(rewritten)
      : "The running manifest declares no content_scripts entry with world: MAIN, so no built bundle was searched for the unknown globals";

    return { hits, bundles };
  }

  if (names.length === 0) return { hits, bundles };

  const found = new Set<string>();

  for (const relative of files) {
    const text = readBundle(path.resolve(distDir), relative, bundles.skipped);
    if (text === null) continue;

    bundles.searched.push(relative);

    for (const name of names) {
      if (found.has(name) || !namesGlobal(text, name)) continue;

      found.add(name);
      hits.push({ name, file: relative });
    }
  }

  return { hits, bundles };
}

export function readExtensionGlobals(input: {
  projectPath: string;
  browser: string;
  manifest: Record<string, unknown>;
  distDir: string | null;
  ownNames: string[];
  unknown: string[] | null;
  exempt: Set<string>;
  leaked: Set<string>;
  dev: boolean;
}): ExtensionGlobals {
  const candidates = input.ownNames.filter((name) => !input.exempt.has(name) && !input.leaked.has(name));
  const engineNames = candidates.filter(isEngineGlobal);
  const toSearch = [...new Set([...engineNames, ...(input.unknown ?? [])])];
  const rewritten = input.dev ? devRewrittenScripts(input.projectPath, input.browser) : [];
  const { hits, bundles } = searchBundles(input.manifest, input.distDir, toSearch, rewritten);
  const fileOf = new Map(hits.map((hit) => [hit.name, hit.file]));
  const engine: EngineGlobal[] = engineNames.map((name) => {
    const file = fileOf.get(name);

    return { name, ...(file ? { file } : {}), ...(input.dev ? { devRuntime: true as const } : {}) };
  });
  const built: BuiltGlobal[] = hits.map((hit) => ({
    ...hit,
    ...(input.dev && isEngineGlobal(hit.name) ? { devRuntime: true as const } : {}),
  }));
  const explained = new Set([...engineNames, ...hits.map((hit) => hit.name)]);

  return {
    engine,
    built,
    bundles,
    unexplained: input.unknown ? input.unknown.filter((name) => !explained.has(name)) : null,
  };
}

export function failingGlobals(globals: ExtensionGlobals): Array<{ name: string; file?: string }> {
  const out: Array<{ name: string; file?: string }> = [];
  const seen = new Set<string>();

  for (const entry of [...globals.engine, ...globals.built]) {
    if (entry.devRuntime || seen.has(entry.name)) continue;

    seen.add(entry.name);
    out.push({ name: entry.name, ...(entry.file ? { file: entry.file } : {}) });
  }

  return out;
}
