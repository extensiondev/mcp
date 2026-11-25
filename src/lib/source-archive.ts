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

import { ignoreGlobMatcher } from "./ignore-glob";
import { SOURCE_SKIPPED_EXTENSIONS, SOURCE_SKIPPED_FOLDERS } from "./source-archive-words";
import { dropTrailing } from "./linear-text";

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
  test: (subject: string) => boolean;
}

function dropUnescapedTrailingSpace(line: string): string {
  const bare = dropTrailing(line, "", { whitespace: true });

  return bare.endsWith("\\") && bare.length < line.length ? line.slice(0, bare.length + 1) : bare;
}

export function parseGitignore(text: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const raw of text.split("\n")) {
    let line = dropUnescapedTrailingSpace(raw.replace(/\r$/, ""));
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
      line = dropTrailing(line, "/");
    }

    if (!line) continue;

    rules.push({
      negated,
      directoryOnly,
      base,
      test: ignoreGlobMatcher(line.replace(/^\//, ""), line.includes("/")),
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

    if (rule.test(subject)) ignored = !rule.negated;
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

const SECRET_FILE_NAME =
  /^(?:\.env(?:\..+)?|\.envrc|\.netrc|_netrc|\.pypirc|\.git-credentials|id_[a-z0-9_-]+|.*\.(?:pem|p8|p12|pfx|key|keystore|jks|ppk|mobileprovision)|credentials\.json|service[-_]account.*\.json|client_secret.*\.json|.+-firebase-adminsdk-.+\.json)$/i;

export const SECRET_FOLDERS = [".aws", ".ssh", ".gnupg"];

const REGISTRY_CONFIG_NAMES = [".npmrc", ".yarnrc.yml"];

const REGISTRY_CREDENTIAL = /(?:_authToken|_auth|_password|npmAuthToken|npmAuthIdent)["']?\s*[=:]\s*(.*)$/i;

const ENVIRONMENT_REFERENCE = /^\$\{[^}]+\}$/;

const PRIVATE_KEY_FIELD = /"private_key"\s*:\s*"-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const SECRET_CONTENT_MAX_BYTES = 1024 * 1024;

/* @invariant A KEY FILE STAYS ON THE MACHINE BY ITS NAME, BEFORE .gitignore
 * IS READ. `.env` and every `.env.*`, `.envrc`, `.netrc`, `.pypirc`,
 * `.git-credentials`, every extensionless `id_*` SSH identity (never its
 * `.pub` half), every `*.pem`, `*.p8` (the App Store Connect AuthKey),
 * `*.p12`, `*.pfx`, `*.key`, `*.keystore`, `*.jks`, `*.ppk` and
 * `*.mobileprovision`, `credentials.json`, `service-account*.json`, the two
 * names Google gives a downloaded credential, and the `.aws`, `.ssh` and
 * `.gnupg` folders are held back and named in `leftOut.secrets`, because a
 * value in them is a
 * secret the moment it leaves the machine. The three example forms of `.env`
 * ship. The platform holds the same list in
 * @extensiondev/contracts/artifact-files and refuses an archive that
 * carries one; a name added on one side is added on both. A shared preview
 * walks a build with the same list, and drops `.npmrc` and `.yarnrc.yml` by
 * name, because a built extension never installs.
 */
export function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SOURCE_SECRET_EXAMPLES.includes(lower)) return false;

  return SECRET_FILE_NAME.test(lower);
}

/* @invariant THREE FILES ARE KEY FILES BY WHAT THEY HOLD, BECAUSE THEIR NAMES
 * ARE ALSO THE NAMES OF ORDINARY PROJECT FILES. `.npmrc` and `.yarnrc.yml`
 * configure the install the platform runs, so they ship unless a line gives
 * a registry credential a literal value; a line that reads it from the
 * environment ships. A service-account key has no name of its own, so a
 * `.json` file is held back when it carries a `private_key` field holding a
 * PEM private key. A file that cannot be read here is left to the archive
 * step, which names the read failure.
 */
export function isInstallConfig(name: string): boolean {
  return REGISTRY_CONFIG_NAMES.includes(name.toLowerCase());
}

export function holdsSecret(name: string, absolute: string, bytes: number): boolean {
  const lower = name.toLowerCase();
  const registry = REGISTRY_CONFIG_NAMES.includes(lower);

  if ((!registry && !lower.endsWith(".json")) || bytes > SECRET_CONTENT_MAX_BYTES) return false;

  let text: string;

  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    return false;
  }

  if (!registry) return PRIVATE_KEY_FIELD.test(text);

  return text.split("\n").some((raw) => {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";")) return false;

    const value = (REGISTRY_CREDENTIAL.exec(line)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");

    return value !== "" && !ENVIRONMENT_REFERENCE.test(value);
  });
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

        if (SECRET_FOLDERS.includes(entry.name)) {
          secrets.push(`${relativePath}/`);
          continue;
        }

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

      const bytes = fs.statSync(absolute).size;

      if (holdsSecret(entry.name, absolute, bytes)) {
        secrets.push(relativePath);
        continue;
      }

      files.push({ path: relativePath, absolute, bytes });
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
