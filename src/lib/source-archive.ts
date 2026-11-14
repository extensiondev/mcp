// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { SOURCE_SKIPPED_EXTENSIONS, SOURCE_SKIPPED_FOLDERS } from "./source-archive-words";

export { megabytes, SOURCE_SKIPPED_EXTENSIONS, SOURCE_SKIPPED_FOLDERS } from "./source-archive-words";

export const SOURCE_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;

export const SOURCE_SECRET_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

const BIGGEST_NAMED = 3;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DEFLATED = 8;

const SKIPPED_FOLDERS = new Set(SOURCE_SKIPPED_FOLDERS);
const SKIPPED_EXTENSIONS = new Set(SOURCE_SKIPPED_EXTENSIONS);

interface IgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  base: string;
  test: RegExp;
}

const ESCAPED = /[.*+?^${}()|[\]\\/]/g;

function globToRegExp(pattern: string): string {
  let out = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);

      if (end > i + 1) {
        const body = pattern.slice(i + 1, end);
        out += `[${(body.startsWith("!") ? `^${body.slice(1)}` : body).replace(/\\/g, "\\\\")}]`;
        i = end;
      } else {
        out += "\\[";
      }
    } else if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[i + 1]!.replace(ESCAPED, "\\$&");
      i += 1;
    } else {
      out += ch.replace(ESCAPED, "\\$&");
    }
  }

  return out;
}

export function parseGitignore(text: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "").replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;

    let negated = false;

    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }

    let directoryOnly = false;

    if (line.endsWith("/")) {
      directoryOnly = true;
      line = line.replace(/\/+$/, "");
    }

    if (!line) continue;

    const anchored = line.includes("/");
    const body = globToRegExp(line.replace(/^\//, ""));

    rules.push({
      negated,
      directoryOnly,
      base,
      test: anchored ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`),
    });
  }

  return rules;
}

export function gitignored(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;

    let subject = relativePath;

    if (rule.base) {
      if (!relativePath.startsWith(`${rule.base}/`)) continue;

      subject = relativePath.slice(rule.base.length + 1);
    }

    if (rule.test.test(subject)) ignored = !rule.negated;
  }

  return ignored;
}

export interface SourceFile {
  path: string;
  absolute: string;
  bytes: number;
}

export interface SourceListing {
  files: SourceFile[];
  leftOut: { secrets: string[] };
}

export function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SOURCE_SECRET_EXAMPLES.includes(lower)) return false;

  return lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".pem");
}

function readIgnoreFile(dir: string, base: string): IgnoreRule[] {
  try {
    return parseGitignore(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), base);
  } catch {
    return [];
  }
}

export function collectSourceFiles(root: string): SourceListing {
  const files: SourceFile[] = [];
  const secrets: string[] = [];

  const walk = (dir: string, relative: string, inherited: IgnoreRule[]) => {
    const rules = [...inherited, ...readIgnoreFile(dir, relative)];
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absolute = path.join(dir, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(entry.name)) continue;
        if (gitignored(relativePath, true, rules)) continue;

        walk(absolute, relativePath, rules);
        continue;
      }

      if (!entry.isFile()) continue;
      if (SKIPPED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      if (isSecretFile(entry.name)) {
        secrets.push(relativePath);
        continue;
      }

      if (gitignored(relativePath, false, rules)) continue;

      files.push({ path: relativePath, absolute, bytes: fs.statSync(absolute).size });
    }
  };

  walk(root, "", []);

  return { files, leftOut: { secrets } };
}

export function sourceManifestPath(root: string): string | null {
  for (const candidate of [path.join(root, "manifest.json"), path.join(root, "src", "manifest.json")]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }

  return null;
}

export function looksLikeExtensionFolder(dir: string): boolean {
  if (sourceManifestPath(dir)) return true;

  try {
    return fs.readdirSync(dir).some((name) => /^extension\.config\.[^.]+$/.test(name));
  } catch {
    return false;
  }
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ArchivedEntry {
  path: string;
  bytes: number;
  zipped: number;
}

export type SourceArchive =
  | { ok: true; zip: Buffer; bytes: number; files: number; entries: ArchivedEntry[]; leftOut: { secrets: string[] } }
  | { ok: false; reason: "too-large"; bytes: number; atLeast: boolean; maxBytes: number; files: number; biggest: Array<{ path: string; bytes: number }> }
  | { ok: false; reason: "unreadable"; message: string };

export function buildSourceArchive(root: string, options: { maxBytes?: number } = {}): SourceArchive {
  const maxBytes = options.maxBytes ?? SOURCE_ARCHIVE_MAX_BYTES;
  let files: SourceFile[];
  let leftOut: { secrets: string[] };

  try {
    ({ files, leftOut } = collectSourceFiles(root));
  } catch (err: any) {
    return { ok: false, reason: "unreadable", message: err?.message || String(err) };
  }

  const stamp = dosDateTime(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const entries: ArchivedEntry[] = [];
  let offset = 0;

  for (const file of files) {
    if (offset > maxBytes) break;

    let data: Buffer;

    try {
      data = fs.readFileSync(file.absolute);
    } catch (err: any) {
      return { ok: false, reason: "unreadable", message: `${file.path}: ${err?.message || err}` };
    }

    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? DEFLATED : STORED;
    const stored = method === DEFLATED ? deflated : data;
    const name = Buffer.from(file.path, "utf8");
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, stored);
    centrals.push(central);
    entries.push({ path: file.path, bytes: data.length, zipped: local.length + stored.length });
    offset += local.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const bytes = offset + directory.length + eocd.length;

  if (bytes > maxBytes || entries.length < files.length) {
    const biggest = [...files]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, BIGGEST_NAMED)
      .map((file) => ({ path: file.path, bytes: file.bytes }));

    return { ok: false, reason: "too-large", bytes, atLeast: entries.length < files.length, maxBytes, files: files.length, biggest };
  }

  return { ok: true, zip: Buffer.concat([...locals, directory, eocd]), bytes, files: entries.length, entries, leftOut };
}
