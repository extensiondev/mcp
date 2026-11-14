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

export type SpecialFolderSettings = Partial<Record<FolderName | "public", string | false>> & { exclude?: string[] };

const CONFIG_FILENAMES = ["extension.config.js", "extension.config.mjs", "extension.config.cjs"];
const CONFIG_READ_TIMEOUT_MS = 15_000;
const SETTINGS_MARK = "__EXTENSION_MCP_FOLDERS__";
const CONFIG_KEYS = ["folders", "exclude"];

const IMPORT_META_ENV_HOOK = String.raw`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !/(^|\/)extension\.config\.(js|mjs)$/.test(new URL(url).pathname)) return nextLoad(url, context);

  let text;

  try {
    text = readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return nextLoad(url, context);
  }

  if (!text.includes("import.meta.env")) return nextLoad(url, context);

  const loaded = await nextLoad(url, { ...context, format: "module" });
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");

  return { ...loaded, source: source.replaceAll("import.meta.env", "globalThis.__EXTENSION_IMPORT_META_ENV__") };
}
`;

const READ_SETTINGS_SCRIPT = String.raw`
import fs from "node:fs";
import path from "node:path";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const [file, browser, mark] = process.argv.slice(-3);

const preloadEnv = (dir) => {
  const shellOwned = new Set(Object.keys(process.env));
  let loaded = false;

  for (const name of [".env.defaults", ".env", ".env.local", ".env.development"]) {
    try {
      const parsed = parseEnv(fs.readFileSync(path.join(dir, name), "utf8"));

      for (const [key, value] of Object.entries(parsed)) if (!shellOwned.has(key)) process.env[key] = value;
      loaded = true;
    } catch {}
  }

  return loaded;
};

const workspaceRootOf = (start) => {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
};

const projectDir = path.dirname(file);

if (!preloadEnv(projectDir)) {
  const workspaceRoot = workspaceRootOf(projectDir);
  if (workspaceRoot && workspaceRoot !== projectDir) preloadEnv(workspaceRoot);
}

if (!file.endsWith(".cjs") && fs.readFileSync(file, "utf8").includes("import.meta.env")) {
  globalThis.__EXTENSION_IMPORT_META_ENV__ = Object.freeze({ ...process.env });

  try {
    register("data:text/javascript," + encodeURIComponent(HOOK_SOURCE));
  } catch {}
}

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
const exclude = [config, layer, command].flatMap((source) => (source && Array.isArray(source.exclude) ? source.exclude : []));

process.stdout.write("\n" + mark + JSON.stringify({ folders: folders && typeof folders === "object" ? folders : null, exclude }) + "\n");
`.replace("HOOK_SOURCE", JSON.stringify(IMPORT_META_ENV_HOOK));

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
 * 705), and exclude from all three layers joined (ledger 740). The config is
 * code, so it is evaluated in a child process the way the engine's own child
 * evaluates it, with the same .env files preloaded and import.meta.env
 * answered, never in this server, and only when its text names folders or
 * exclude at all. A config that cannot be read leaves the default folders in
 * place.
 */
export function specialFolderSettings(projectRoots: string[], browser: string): SpecialFolderSettings {
  const file = configFileOf([...new Set(projectRoots.map((root) => path.resolve(root)))]);
  if (!file) return {};

  try {
    const text = fs.readFileSync(file, "utf8");
    if (!CONFIG_KEYS.some((key) => text.includes(key))) return {};

    const out = execFileSync(process.execPath, ["--input-type=module", "-e", READ_SETTINGS_SCRIPT, file, browser, SETTINGS_MARK], {
      cwd: path.dirname(file),
      encoding: "utf8",
      timeout: CONFIG_READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const line = out.split("\n").reverse().find((row) => row.startsWith(SETTINGS_MARK));
    const parsed = (line ? JSON.parse(line.slice(SETTINGS_MARK.length)) : null) as { folders?: unknown; exclude?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return {};

    const settings: SpecialFolderSettings = {};
    const folders = parsed.folders && typeof parsed.folders === "object" ? (parsed.folders as Record<string, unknown>) : {};

    for (const name of ["pages", "scripts", "public"] as const) {
      const value = folders[name];
      if (value === false || (typeof value === "string" && value.trim())) settings[name] = value;
    }

    const exclude = (Array.isArray(parsed.exclude) ? parsed.exclude : []).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
    if (exclude.length) settings.exclude = exclude;

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

const DEV_ONLY_ENTRY = /\.dev\.[^.]+$/i;

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "dns", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "worker_threads", "zlib",
]);

const NODE_BUILD_TOOLS = new Set([
  "fs-extra", "esbuild", "playwright", "playwright-core", "puppeteer", "puppeteer-core", "webpack", "rollup", "vite", "replace-in-file", "zip-dir", "archiver", "adm-zip", "chokidar",
  "glob", "fast-glob", "rimraf", "yargs", "execa", "cross-spawn", "shelljs", "web-ext", "dotenv", "node-fetch", "minimist", "ora", "chalk", "gulp", "grunt", "ncp", "del", "cpy", "tsx",
  "ts-node", "nodemon", "concurrently",
]);

const SIBLING_EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const REFERENCE_SOURCE_EXTENSIONS = new Set([".html", ".htm", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"]);
const REFERENCE_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".output", "coverage", ".next", ".cache", ".git", ".turbo", "scripts"]);
const REFERENCE_MAX_FILES = 4000;
const REFERENCE_MAX_BYTES = 12_582_912;
const COMPILED_TO_JS_EXTENSIONS = new Set([".ts", ".tsx", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function insideDir(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);

  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function importsNodeOnly(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;

  const bare = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

  return NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(bare) || NODE_BUILD_TOOLS.has(bare);
}

function siblingOf(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);

  for (const extension of SIBLING_EXTENSIONS) {
    try {
      if (fs.statSync(`${base}${extension}`).isFile()) return `${base}${extension}`;
    } catch {
      continue;
    }
  }

  return null;
}

function isNodeToolingScript(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;

  seen.add(file);

  let source: string;

  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }

  if (/^#!.*\bnode\b/.test(source)) return true;

  const specifiers = /(?:require\s*\(\s*|(?:import|export)\b[^'"()]*?\bfrom\s*|import\s*)['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(specifiers)) {
    const specifier = match[1];
    if (importsNodeOnly(specifier)) return true;
    if (!specifier.startsWith(".")) continue;

    const sibling = siblingOf(file, specifier);
    if (sibling && isNodeToolingScript(sibling, seen)) return true;
  }

  return false;
}

function packageScriptsText(root: string): string {
  try {
    const scripts: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;

    return Object.values(scripts && typeof scripts === "object" ? scripts : {}).map(String).join("\n");
  } catch {
    return "";
  }
}

function referenceCorpus(root: string): string {
  const parts: string[] = [];
  let bytes = 0;
  const full = () => parts.length >= REFERENCE_MAX_FILES || bytes >= REFERENCE_MAX_BYTES;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (full()) return;

      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!REFERENCE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(file);

        continue;
      }

      if (!entry.isFile()) continue;
      if (!/^manifest\b.*\.json$/i.test(entry.name) && !REFERENCE_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const text = fs.readFileSync(file, "utf8");
        parts.push(text);
        bytes += text.length;
      } catch {
        continue;
      }
    }
  };

  walk(root);

  return parts.join("\n");
}

function packageToolingScripts(root: string, scripts: Array<{ file: string; key: string }>): Set<string> {
  const dropped = new Set<string>();
  const tooling = packageScriptsText(root);
  if (tooling === "") return dropped;

  const relativeOf = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const run = scripts.filter((script) => tooling.includes(relativeOf(script.file)));
  if (!run.length) return dropped;

  const corpus = referenceCorpus(root);
  if (corpus === "") return dropped;

  for (const script of run) {
    const relative = relativeOf(script.file);
    const extension = path.extname(relative);
    const spellings = [relative, `${script.key}${extension}`, `${script.key}.js`];
    if (COMPILED_TO_JS_EXTENSIONS.has(extension.toLowerCase())) spellings.push(`${relative.slice(0, -extension.length)}.js`);

    if (!spellings.some((spelling) => corpus.includes(spelling))) dropped.add(script.file);
  }

  return dropped;
}

/* @invariant THE ENTRY LIST LEAVES OUT WHAT THE BUILD LEAVES OUT. Extension.js
 * drops from pages/ and scripts/ a file under the public folder, a file
 * exclude names, a .dev. file in a production build, a script that imports
 * Node-only modules, and a script a package.json script runs that nothing in
 * the extension names (finalizeSpecialFoldersData, ledger 740). A .dev. file
 * stays listed when the dist holds it, since that dist came from a dev run.
 */
export function specialFolderEntrypoints(projectRoots: string[], distDir: string, settings: SpecialFolderSettings = {}): SpecialFolderEntry[] {
  const roots = [...new Set(projectRoots.map((root) => path.resolve(root)))];
  const excluded = new Set(roots.flatMap((root) => (settings.exclude ?? []).map((entry) => path.resolve(root, entry))));
  const seen = new Set<string>();
  const out: SpecialFolderEntry[] = [];

  for (const root of roots) {
    const publicDir = typeof settings.public === "string" && settings.public.trim() ? path.resolve(root, settings.public) : path.join(root, "public");

    for (const folder of SPECIAL_FOLDERS) {
      const dir = folderDir(root, folder.name, settings[folder.name]);
      if (!dir) continue;

      const found = filesUnder(dir, folder.keeps).map((file) => {
        const emitted = emittedPath(folder.name, path.relative(dir, file).split(path.sep).join("/"), folder.emits);

        return { file, emitted, key: emitted.slice(0, -folder.emits.length) };
      });
      const scripts = folder.name === "scripts" ? found.filter((entry) => !isNodeToolingScript(entry.file)) : found;
      const tooling = folder.name === "scripts" ? packageToolingScripts(root, scripts) : new Set<string>();

      for (const { file, emitted } of scripts) {
        if (tooling.has(file) || insideDir(publicDir, file) || excluded.has(path.resolve(file))) continue;

        const role = path.relative(root, file).split(path.sep).join("/");
        if (seen.has(role)) continue;

        const present = fs.existsSync(path.join(distDir, emitted));
        if (!present && DEV_ONLY_ENTRY.test(path.basename(file))) continue;

        seen.add(role);
        out.push({ role, path: emitted, present });
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
