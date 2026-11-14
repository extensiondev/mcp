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

export interface SpecialFolderEntry {
  role: string;
  path: string;
  present: boolean;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".jsx", ".mjsx", ".ts", ".mts", ".tsx", ".mtsx"]);

type FolderName = "pages" | "scripts";

const SPECIAL_FOLDERS: ReadonlyArray<{ name: FolderName; keeps: (file: string) => boolean; emits: string }> = [
  { name: "pages", keeps: (file) => file.endsWith(".html"), emits: ".html" },
  { name: "scripts", keeps: (file) => SCRIPT_EXTENSIONS.has(path.extname(file)), emits: ".js" },
];

export type SpecialFolderSettings = Partial<Record<FolderName, string | false>>;

const CONFIG_FILENAMES = ["extension.config.js", "extension.config.mjs", "extension.config.cjs"];
const CONFIG_READ_TIMEOUT_MS = 15_000;
const FOLDERS_MARK = "__EXTENSION_MCP_FOLDERS__";

const READ_FOLDERS_SCRIPT = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [file, browser, mark] = process.argv.slice(-3);
let loaded;

try {
  loaded = file.endsWith(".cjs") ? createRequire(file)(file) : await import(pathToFileURL(file).href);
} catch (error) {
  if (file.endsWith(".mjs")) throw error;
  loaded = createRequire(file)(file);
}

const config = loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded;
const browsers = (config && config.browser) || {};
const family = { "chromium-based": "chromium", "gecko-based": "firefox", "webkit-based": "safari" }[browser];
const layer = browsers[browser] || (family ? browsers[family] : undefined) || {};
const command = (config && config.commands && config.commands.build) || {};
const folders = command.folders ?? layer.folders ?? (config ? config.folders : undefined);

process.stdout.write("\\n" + mark + JSON.stringify(folders && typeof folders === "object" ? folders : null) + "\\n");
`;

function configFileOf(roots: string[]): string | null {
  for (const root of roots) {
    for (const name of CONFIG_FILENAMES) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) return file;
    }
  }

  return null;
}

/* @invariant THE ENTRY LIST READS THE FOLDERS THE BUILD READ. Extension.js
 * takes folders from commands.build, else the browser's block, else the top
 * level of extension.config.js, one layer whole and never merged (ledger
 * 705). The config is code, so it is evaluated in a child process the way
 * the engine's own child evaluates it, never in this server, and only when
 * its text names folders at all. A config that cannot be read leaves the
 * default folders in place.
 */
export function specialFolderSettings(projectRoots: string[], browser: string): SpecialFolderSettings {
  const file = configFileOf([...new Set(projectRoots.map((root) => path.resolve(root)))]);
  if (!file) return {};

  try {
    if (!fs.readFileSync(file, "utf8").includes("folders")) return {};

    const out = execFileSync(process.execPath, ["--input-type=module", "-e", READ_FOLDERS_SCRIPT, file, browser, FOLDERS_MARK], {
      cwd: path.dirname(file),
      encoding: "utf8",
      timeout: CONFIG_READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const line = out.split("\n").reverse().find((row) => row.startsWith(FOLDERS_MARK));
    const parsed: unknown = line ? JSON.parse(line.slice(FOLDERS_MARK.length)) : null;
    if (!parsed || typeof parsed !== "object") return {};

    const settings: SpecialFolderSettings = {};

    for (const name of ["pages", "scripts"] as const) {
      const value = (parsed as Record<string, unknown>)[name];
      if (value === false || (typeof value === "string" && value.trim())) settings[name] = value;
    }

    return settings;
  } catch {
    return {};
  }
}

function folderDir(root: string, name: FolderName, setting: string | false | undefined): string | null {
  const standard = path.join(root, name);
  if (setting === false) return null;
  if (typeof setting !== "string" || !setting.trim()) return standard;

  const moved = path.resolve(root, setting);
  if (moved === path.resolve(standard)) return standard;

  return path.basename(moved) === name ? moved : null;
}

function filesUnder(dir: string, keeps: (file: string) => boolean): string[] {
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) files.push(...filesUnder(full, keeps));
    else if (entry.isFile() && keeps(entry.name)) files.push(full);
  }

  return files;
}

function emittedPath(folder: string, relative: string, emits: string): string {
  let stem = relative.slice(0, -path.extname(relative).length);
  if (folder === "pages" && stem.endsWith("/index")) stem = stem.slice(0, -"/index".length);
  if (stem === "") stem = "index";

  return `${folder}/${stem}${emits}`;
}

export function specialFolderEntrypoints(projectRoots: string[], distDir: string, settings: SpecialFolderSettings = {}): SpecialFolderEntry[] {
  const roots = [...new Set(projectRoots.map((root) => path.resolve(root)))];
  const seen = new Set<string>();
  const out: SpecialFolderEntry[] = [];

  for (const root of roots) {
    for (const folder of SPECIAL_FOLDERS) {
      const dir = folderDir(root, folder.name, settings[folder.name]);
      if (!dir) continue;

      for (const file of filesUnder(dir, folder.keeps)) {
        const relative = path.relative(dir, file).split(path.sep).join("/");
        const role = path.relative(root, file).split(path.sep).join("/");
        if (seen.has(role)) continue;

        seen.add(role);
        const emitted = emittedPath(folder.name, relative, folder.emits);

        out.push({ role, path: emitted, present: fs.existsSync(path.join(distDir, emitted)) });
      }
    }
  }

  return out;
}

export function specialFolderMissingNote(entries: SpecialFolderEntry[], distDir: string): string | null {
  const missing = entries.filter((entry) => !entry.present);
  if (!missing.length) return null;

  const named = missing.map((entry) => `${entry.role} (expected ${entry.path})`).join(", ");

  return `${missing.length === 1 ? "One special-folder file was" : `${missing.length} special-folder files were`} not emitted into ${distDir}: ${named}. Extension.js compiles every .html under pages/ and every script under scripts/, at the project root or where extension.config.js folders puts them, unless the config excludes the file, so either that exclusion is intended or the page is not shipping.`;
}
