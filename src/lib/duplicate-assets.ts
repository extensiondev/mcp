// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DUPLICATE_ASSET_FLOOR = 256 * 1024;

export const LARGE_ASSET_FLOOR = 5 * 1024 * 1024;

export interface SizedFile {
  path: string;
  size: number;
}

export interface DuplicateGroup {
  size: number;
  sizeFormatted: string;
  sha256: string;
  paths: string[];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function listDistFiles(root: string, base = ""): SizedFile[] {
  const out: SizedFile[] = [];

  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...listDistFiles(path.join(root, entry.name), rel));
      continue;
    }

    try {
      out.push({ path: rel, size: fs.statSync(path.join(root, entry.name)).size });
    } catch {
    }
  }

  return out;
}

function sha256Of(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/* @invariant A DUPLICATE IS THE SAME BYTES TWICE, NOT THE SAME NAME. Two
 * emitted files are called duplicates only when they have the same size and
 * the same sha256, and only files at or above the floor are hashed, so a
 * build with thousands of small chunks costs nothing here. The bundler emits
 * a worker's wasm as assets/<name>.<hash>.wasm, and a config plugin or a
 * public/ copy of the same file lands beside it under its plain name; the
 * engine printed its asset tree and total with no word about the pair, and
 * a 14 MiB file shipped twice until the project's own size test listed both
 * (ledger 422). */
export function findDuplicateAssets(root: string, files: SizedFile[], floor = DUPLICATE_ASSET_FLOOR): DuplicateGroup[] {
  const bySize = new Map<number, SizedFile[]>();

  for (const file of files) {
    if (file.size < floor) continue;

    const same = bySize.get(file.size) ?? [];
    same.push(file);
    bySize.set(file.size, same);
  }

  const groups: DuplicateGroup[] = [];

  for (const [size, same] of bySize) {
    if (same.length < 2) continue;

    const byHash = new Map<string, string[]>();

    for (const file of same) {
      const hash = sha256Of(path.join(root, file.path));
      if (!hash) continue;

      const paths = byHash.get(hash) ?? [];
      paths.push(file.path);
      byHash.set(hash, paths);
    }

    for (const [sha256, paths] of byHash) {
      if (paths.length < 2) continue;

      groups.push({ size, sizeFormatted: formatBytes(size), sha256, paths: [...paths].sort() });
    }
  }

  return groups.sort((a, b) => b.size - a.size);
}

export function duplicateOf(groups: DuplicateGroup[], file: string): string | undefined {
  for (const group of groups) {
    const at = group.paths.indexOf(file);
    if (at > 0) return group.paths[0];
  }

  return undefined;
}

export function duplicateAssetSentence(group: DuplicateGroup): string {
  const [first, ...rest] = group.paths;
  const hashed = rest.some((p) => /\.[0-9a-f]{8,}\.\w+$/i.test(p)) || /\.[0-9a-f]{8,}\.\w+$/i.test(first ?? "");
  const cause = hashed
    ? " The hashed name is the copy an import already emits; the plain one usually comes from bundledFiles, a config plugin or public/, so drop that one."
    : " One of them usually comes from bundledFiles, a config plugin or public/; drop all but one.";

  return `${rest.join(", ")} ${rest.length === 1 ? "is" : "are"} the same ${group.sizeFormatted} as ${first} (sha256 ${group.sha256.slice(0, 12)}), so the package ships those bytes ${group.paths.length} times.${cause}`;
}

export function largestFilesOf(files: SizedFile[], groups: DuplicateGroup[], count = 5): Array<SizedFile & { sizeFormatted: string; duplicateOf?: string }> {
  return [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, count)
    .map((file) => {
      const twin = duplicateOf(groups, file.path);

      return { path: file.path, size: file.size, sizeFormatted: formatBytes(file.size), ...(twin ? { duplicateOf: twin } : {}) };
    });
}
