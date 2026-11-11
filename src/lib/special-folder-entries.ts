// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

export interface SpecialFolderEntry {
  role: string;
  path: string;
  present: boolean;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".jsx", ".mjsx", ".ts", ".mts", ".tsx", ".mtsx"]);

const SPECIAL_FOLDERS: ReadonlyArray<{ name: string; keeps: (file: string) => boolean; emits: string }> = [
  { name: "pages", keeps: (file) => file.endsWith(".html"), emits: ".html" },
  { name: "scripts", keeps: (file) => SCRIPT_EXTENSIONS.has(path.extname(file)), emits: ".js" },
];

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

export function specialFolderEntrypoints(projectRoots: string[], distDir: string): SpecialFolderEntry[] {
  const roots = [...new Set(projectRoots.map((root) => path.resolve(root)))];
  const seen = new Set<string>();
  const out: SpecialFolderEntry[] = [];

  for (const root of roots) {
    for (const folder of SPECIAL_FOLDERS) {
      const dir = path.join(root, folder.name);

      for (const file of filesUnder(dir, folder.keeps)) {
        const relative = path.relative(dir, file).split(path.sep).join("/");
        const role = `${folder.name}/${relative}`;
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

  return `${missing.length === 1 ? "One special-folder file was" : `${missing.length} special-folder files were`} not emitted into ${distDir}: ${named}. Extension.js compiles every .html under pages/ and every script under scripts/ at the project root unless extension.config.js turns the folder off or excludes the file, so either that exclusion is intended or the page is not shipping.`;
}
