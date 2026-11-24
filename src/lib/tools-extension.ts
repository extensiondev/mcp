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
import { fileURLToPath } from "node:url";

import { readZipEntry, unpackZip } from "./zip-entries";

export const MIN_TOOLS_VERSION = "0.1.2";

export const TOOLS_ITEMS = {
  chrome: { id: "omndndgipeomhfdobfbhpfemempnnpjp", store: "the Chrome Web Store" },
  edge: { id: "pnijfgjkilbnmjiomlajfbmiccjejbpm", store: "Edge Add-ons" },
} as const;

export type ToolsStore = keyof typeof TOOLS_ITEMS;

export type BundleFolder = "chromium" | "firefox";

export interface ToolsBundleRecord {
  version: string;
  sha256: Record<BundleFolder, string>;
}

export interface ToolsExtension {
  dir: string;
  version: string;
  source: ToolsStore | "bundled";
  note: string;
}

const CRX_MAGIC = "Cr24";
const SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\x00", "binary");
const MAX_CRX_BYTES = 16 * 1024 * 1024;
const UNPACK_LIMITS = { maxEntries: 2_000, maxBytes: 64 * 1024 * 1024 };
const DOWNLOAD_TIMEOUT_MS = 15_000;

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function crxIdOf(publicKey: Buffer): string {
  const digest = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);

  return [...digest.toString("hex")].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join("");
}

function crxIdFromBytes(bytes: Buffer): string {
  return [...bytes.toString("hex")].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join("");
}

interface ProtoField {
  field: number;
  bytes: Buffer;
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let cursor = at;

  while (cursor < buf.length && shift < 35) {
    const byte = buf[cursor] as number;
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, next: cursor };

    shift += 7;
  }

  return null;
}

function protoFields(buf: Buffer): ProtoField[] | null {
  const out: ProtoField[] = [];
  let at = 0;

  while (at < buf.length) {
    const tag = readVarint(buf, at);
    if (!tag) return null;

    const wire = tag.value % 8;
    const field = Math.floor(tag.value / 8);

    if (wire === 2) {
      const length = readVarint(buf, tag.next);
      if (!length || length.next + length.value > buf.length) return null;

      out.push({ field, bytes: buf.subarray(length.next, length.next + length.value) });
      at = length.next + length.value;
    } else if (wire === 0) {
      const skipped = readVarint(buf, tag.next);
      if (!skipped) return null;

      at = skipped.next;
    } else {
      return null;
    }
  }

  return out;
}

export type CrxRead = { ok: true; zip: Buffer } | { ok: false; reason: string };

/* @invariant A STORE DOWNLOAD IS LOADED ONLY WHEN ITS CRX3 SIGNATURE PROVES
 * THE EXPECTED ITEM. The signed header names a crx_id; it must be the item id
 * asked for, one sha256_with_rsa proof's public key must hash to it, and that
 * proof's signature must verify over the signed header and the archive. Any
 * other answer is refused and the bundled copy is loaded instead.
 */
export function readCrx3(bytes: Buffer, expectedId: string): CrxRead {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("binary") !== CRX_MAGIC) return { ok: false, reason: "the download is not a CRX file" };
  if (bytes.readUInt32LE(4) !== 3) return { ok: false, reason: `the download is CRX version ${bytes.readUInt32LE(4)}, not 3` };

  const headerSize = bytes.readUInt32LE(8);
  if (12 + headerSize > bytes.length) return { ok: false, reason: "the CRX header is cut short" };

  const header = protoFields(bytes.subarray(12, 12 + headerSize));
  if (!header) return { ok: false, reason: "the CRX header does not parse" };

  const signedHeader = header.find((entry) => entry.field === 10000)?.bytes;
  const declared = signedHeader ? protoFields(signedHeader)?.find((entry) => entry.field === 1)?.bytes : undefined;
  if (!signedHeader || !declared || declared.length !== 16) return { ok: false, reason: "the CRX header names no crx_id" };

  const declaredId = crxIdFromBytes(declared);
  if (declaredId !== expectedId) return { ok: false, reason: `the CRX names item ${declaredId}, not ${expectedId}` };

  const zip = bytes.subarray(12 + headerSize);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([SIGNED_DATA_PREFIX, size, signedHeader, zip]);

  for (const proof of header.filter((entry) => entry.field === 2)) {
    const parts = protoFields(proof.bytes);
    const publicKey = parts?.find((part) => part.field === 1)?.bytes;
    const signature = parts?.find((part) => part.field === 2)?.bytes;
    if (!publicKey || !signature || crxIdOf(publicKey) !== expectedId) continue;

    try {
      const key = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });

      if (crypto.verify("sha256", signed, key, signature)) return { ok: true, zip };
    } catch {
      return { ok: false, reason: "the CRX key of the item does not parse" };
    }

    return { ok: false, reason: "the CRX signature of the item does not verify" };
  }

  return { ok: false, reason: `no CRX proof is signed by the key of item ${expectedId}` };
}

export function crxDownloadUrl(store: ToolsStore, prodVersion = "140.0.0.0"): string {
  const id = TOOLS_ITEMS[store].id;

  return store === "edge"
    ? `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`
    : `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx3&prodversion=${prodVersion}&x=${encodeURIComponent(`id=${id}&uc`)}`;
}

export function packageRoot(from: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg?.name === "@extension.dev/mcp") return dir;
    } catch {
    }

    if (path.dirname(dir) === dir) return null;
  }
}

export function bundledToolsDir(root: string | null = packageRoot()): string | null {
  return root ? path.join(root, "bundled", "extension-dev-tools") : null;
}

export function readBundleRecord(dir: string): ToolsBundleRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));

    return typeof record?.version === "string" && record.sha256 ? (record as ToolsBundleRecord) : null;
  } catch {
    return null;
  }
}

function filesUnder(root: string, dir = root): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...filesUnder(root, full));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }

  return out.sort();
}

export function treeSha256(root: string): string {
  const whole = crypto.createHash("sha256");

  for (const rel of filesUnder(root)) {
    whole.update(`${rel}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex")}\n`);
  }

  return whole.digest("hex");
}

function manifestVersion(dir: string): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version ?? "");
  } catch {
    return "";
  }
}

function placed(cacheDir: string, name: string, fill: (into: string) => void): string {
  const target = path.join(cacheDir, name);
  if (fs.existsSync(path.join(target, "manifest.json"))) return target;

  const staging = `${target}.${process.pid}.${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fill(staging);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);

  return target;
}

function bundledCopy(cacheDir: string, folder: BundleFolder, bundleDir: string | null, because: string): ToolsExtension | { failed: string } {
  const record = bundleDir ? readBundleRecord(bundleDir) : null;
  const source = bundleDir ? path.join(bundleDir, folder) : "";

  if (!record || !source || !fs.existsSync(path.join(source, "manifest.json"))) {
    return { failed: "the copy of extension.dev tools bundled with this MCP is missing from its package" };
  }

  const dir = placed(cacheDir, `bundled-${folder}-${record.version}-${String(record.sha256[folder]).slice(0, 12)}`, (into) => fs.cpSync(source, into, { recursive: true }));

  const note = `${because}extension.dev tools ${record.version} is the copy bundled with this MCP.`;

  return { dir, version: record.version, source: "bundled", note: note.charAt(0).toUpperCase() + note.slice(1) };
}

type StoreRead = { ok: true; zip: Buffer; version: string } | { ok: false; reason: string };

async function readStore(store: ToolsStore, fetchImpl: typeof fetch): Promise<StoreRead> {
  let bytes: Buffer;

  try {
    const res = await fetchImpl(crxDownloadUrl(store), { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `it answered ${res.status}` };

    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: `it could not be reached (${err instanceof Error ? err.message : String(err)})` };
  }

  if (bytes.length > MAX_CRX_BYTES) return { ok: false, reason: `its download is over ${MAX_CRX_BYTES} bytes` };

  const crx = readCrx3(bytes, TOOLS_ITEMS[store].id);
  if (!crx.ok) return { ok: false, reason: `its download was refused: ${crx.reason}` };

  const manifest = readZipEntry(crx.zip, "manifest.json", { maxEntries: UNPACK_LIMITS.maxEntries, maxBytes: 1024 * 1024 });
  if (!manifest.ok) return { ok: false, reason: `its download holds no readable manifest (${manifest.message})` };

  try {
    return { ok: true, zip: crx.zip, version: String(JSON.parse(manifest.data.toString("utf8")).version ?? "") };
  } catch {
    return { ok: false, reason: "its download holds a manifest that does not parse" };
  }
}

export async function resolveToolsExtension(options: {
  engine: "chromium" | "gecko";
  edge: boolean;
  cacheDir: string;
  fetchImpl: typeof fetch;
  bundleDir?: string | null;
}): Promise<ToolsExtension | { failed: string }> {
  const bundleDir = options.bundleDir === undefined ? bundledToolsDir() : options.bundleDir;

  if (options.engine === "gecko") return bundledCopy(options.cacheDir, "firefox", bundleDir, "Firefox Add-ons lists the add-on unlisted, so ");

  const store: ToolsStore = options.edge ? "edge" : "chrome";
  const name = TOOLS_ITEMS[store].store;
  const read = await readStore(store, options.fetchImpl);

  if (!read.ok) return bundledCopy(options.cacheDir, "chromium", bundleDir, `${name} was not used because ${read.reason}, so `);

  if (compareVersions(read.version, MIN_TOOLS_VERSION) < 0) {
    return bundledCopy(options.cacheDir, "chromium", bundleDir, `${name} serves ${read.version}, older than ${MIN_TOOLS_VERSION}, so `);
  }

  let unpackFailure = "";

  const dir = placed(options.cacheDir, `${store}-${read.version}`, (into) => {
    const unpacked = unpackZip(read.zip, into, UNPACK_LIMITS);
    if (!unpacked.ok) unpackFailure = unpacked.message;

    fs.rmSync(path.join(into, "_metadata"), { recursive: true, force: true });
  });

  if (unpackFailure || manifestVersion(dir) !== read.version) {
    fs.rmSync(dir, { recursive: true, force: true });

    return bundledCopy(options.cacheDir, "chromium", bundleDir, `${name} was not used because its download did not unpack, so `);
  }

  return { dir, version: read.version, source: store, note: `extension.dev tools ${read.version} comes from ${name}.` };
}
