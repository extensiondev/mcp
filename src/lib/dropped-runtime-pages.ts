// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { WEBKIT_FAMILY } from "./browser-family";
import { engineManifestView } from "./engine-manifest-view";
import { sourceManifest } from "./manifest-by-browser";
import { posixPath } from "./session-paths";
import { scanRoots } from "./store-code-facts";

type Manifest = Record<string, unknown>;

export interface DroppedRuntimePage {
  file: string;
  declaredUnder: string[];
  openedBy: string[];
  say: string;
}

const WEBKIT_DROPPED_TOP_LEVEL_KEYS = new Set([
  "side_panel",
  "sidebar_action",
  "sandbox",
  "user_scripts",
  "omnibox",
  "chrome_settings_overrides",
  "tts_engine",
  "file_browser_handlers",
  "input_components",
  "cross_origin_embedder_policy",
  "cross_origin_opener_policy",
  "requirements",
  "oauth2",
  "nacl_modules",
  "replacement_web_app",
  "offline_enabled",
  "differential_fingerprint",
  "incognito",
]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage", ".turbo", ".next", "store"]);
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte"]);
const MAX_FILES = 300;
const MAX_BYTES = 512 * 1024;
const MAX_SITES = 5;
const NOT_A_PAGE_KEYS = new Set(["web_accessible_resources"]);

function cleanPath(ref: string): string {
  return ref.replace(/^\.?\/+/, "");
}

function htmlDeclarations(node: unknown, at: string, into: Map<string, string[]>): void {
  if (typeof node === "string") {
    if (!/\.html?$/i.test(node) || /^(https?:|data:)/i.test(node)) return;

    const file = cleanPath(node);
    into.set(file, [...(into.get(file) ?? []), at]);

    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => htmlDeclarations(item, `${at}[${index}]`, into));

    return;
  }

  if (!node || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node as Manifest)) {
    if (!at && NOT_A_PAGE_KEYS.has(key.replace(/^[a-z-]+:/, ""))) continue;

    htmlDeclarations(value, at ? `${at}.${key}` : key, into);
  }
}

function keptView(manifest: Manifest, browser: string): Manifest {
  const view = engineManifestView(manifest, browser);
  if (!WEBKIT_FAMILY.has(browser)) return view;

  return Object.fromEntries(Object.entries(view).filter(([key]) => !WEBKIT_DROPPED_TOP_LEVEL_KEYS.has(key)));
}

function sourceFiles(roots: string[]): string[] {
  const files: string[] = [];
  const stack = [...roots].reverse();

  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name) && !/^(tests?|__tests__|e2e|spec)$/.test(entry.name)) stack.push(full);

        continue;
      }

      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase()) || /\.(test|spec)\.[a-z]+$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
      if (files.length >= MAX_FILES) break;

      files.push(full);
    }
  }

  return files;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function sitesNaming(files: string[], root: string, pages: string[]): Map<string, string[]> {
  const sites = new Map<string, string[]>(pages.map((page) => [page, []]));
  const patterns = pages.map((page) => [page, new RegExp(`["'\`/]${escapeRegExp(page)}["'\`?#]`)] as const);

  for (const file of files) {
    let body: string;

    try {
      if (fs.statSync(file).size > MAX_BYTES) continue;

      body = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const lines = body.split("\n");

    for (const [page, pattern] of patterns) {
      const found = sites.get(page)!;
      if (found.length >= MAX_SITES || !body.includes(page)) continue;

      const line = lines.findIndex((text) => pattern.test(text));
      if (line >= 0) found.push(`${posixPath(path.relative(root, file) || file)}:${line + 1}`);
    }
  }

  return sites;
}

function sentence(file: string, keys: string[], browser: string, sites: string[], distDir: string | null): string {
  const where = distDir ? `${path.basename(path.dirname(distDir))}/${path.basename(distDir)} has no copy of it` : `the ${browser} build will have no copy of it`;
  const stem = /^index\.html?$/i.test(path.basename(file)) && path.dirname(file) !== "." ? `${path.basename(path.dirname(file))}.html` : path.basename(file);

  return `${file} is declared only under ${keys.join(" and ")}, which the ${browser} build does not keep, so ${where}, but ${sites.join(", ")} names it at runtime (runtime.getURL, windows.create or tabs.create reach it by that path) and ${browser} answers "can't find the file" when it opens; move the page to pages/${stem} at the project root, which the engine emits for every browser, or declare it under a manifest key the ${browser} build keeps.`;
}

export function droppedRuntimePages(
  projectPath: string,
  browser: string,
  distDir: string | null = null,
  manifest: Manifest | null = sourceManifest(projectPath),
): DroppedRuntimePage[] {
  if (!manifest) return [];
  if (distDir && !fs.existsSync(path.join(distDir, "manifest.json"))) return [];

  const root = path.resolve(projectPath);
  const declared = new Map<string, string[]>();
  htmlDeclarations(manifest, "", declared);
  if (!declared.size) return [];

  const kept = new Map<string, string[]>();
  htmlDeclarations(keptView(manifest, browser), "", kept);

  const candidates = [...declared.entries()].filter(([file]) => {
    if (kept.has(file)) return false;
    if (distDir) return !fs.existsSync(path.join(distDir, file));

    return !(file.startsWith("pages/") && fs.existsSync(path.join(root, file)));
  });
  if (!candidates.length) return [];

  const sites = sitesNaming(sourceFiles(scanRoots(root)), root, candidates.map(([file]) => file));

  return candidates
    .filter(([file]) => sites.get(file)!.length > 0)
    .map(([file, keys]) => ({
      file,
      declaredUnder: keys,
      openedBy: sites.get(file)!,
      say: sentence(file, keys, browser, sites.get(file)!, distDir),
    }));
}

export function isDroppedRuntimePageWarning(line: unknown): boolean {
  return typeof line === "string" && / is declared only under .* which the \S+ build does not keep, so /.test(line);
}
