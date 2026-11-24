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

export const MIN_TOOLS_VERSION = "0.1.3";

export const LAUNCH_FILE = "launch.json";

export const TOOLS_ITEMS = {
  chrome: { id: "omndndgipeomhfdobfbhpfemempnnpjp", publisher: "lfoeajgcchlidpicbabpmckkejpckcfb", store: "the Chrome Web Store" },
  edge: { id: "pnijfgjkilbnmjiomlajfbmiccjejbpm", publisher: "ichpfokaninimeilopnpeolpmboclkbm", store: "Edge Add-ons" },
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
  source: ToolsStore | "firefox" | "bundled";
  note: string;
}

const CRX_MAGIC = "Cr24";
const SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\x00", "binary");
const MAX_CRX_BYTES = 16 * 1024 * 1024;

export const AMO_ADDON_ID = "sidekick@extension.dev";

export const AMO_ADDON_API = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(AMO_ADDON_ID)}/`;
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

type ProofCheck = "verified" | "missing" | "unparsed" | "unverified";

function proofBy(proofs: ProtoField[], id: string, signed: Buffer): ProofCheck {
  for (const proof of proofs) {
    const parts = protoFields(proof.bytes);
    const publicKey = parts?.find((part) => part.field === 1)?.bytes;
    const signature = parts?.find((part) => part.field === 2)?.bytes;
    if (!publicKey || !signature || crxIdOf(publicKey) !== id) continue;

    try {
      const key = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });

      return crypto.verify("sha256", signed, key, signature) ? "verified" : "unverified";
    } catch {
      return "unparsed";
    }
  }

  return "missing";
}

const PROOF_REASONS: Record<Exclude<ProofCheck, "verified">, (who: string) => string> = {
  missing: (who) => `no CRX proof is signed by the key of ${who}`,
  unparsed: (who) => `the CRX key of ${who} does not parse`,
  unverified: (who) => `the CRX signature of ${who} does not verify`,
};

/* @invariant A STORE DOWNLOAD IS LOADED ONLY WHEN ITS CRX3 SIGNATURES PROVE
 * THE EXPECTED ITEM AND ITS STORE. The signed header names a crx_id; it must
 * be the item id asked for, a sha256_with_rsa proof whose public key hashes to
 * that id must verify over the signed header and the archive, and so must the
 * store's own publisher proof (the Chrome Web Store signs with the key of
 * lfoeajgcchlidpicbabpmckkejpckcfb, Edge Add-ons with the key of
 * ichpfokaninimeilopnpeolpmboclkbm). Any other answer is refused and the
 * bundled copy is loaded instead.
 */
export function readCrx3(bytes: Buffer, expectedId: string, publisherId?: string): CrxRead {
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
  const proofs = header.filter((entry) => entry.field === 2);
  const item = proofBy(proofs, expectedId, signed);
  if (item !== "verified") return { ok: false, reason: PROOF_REASONS[item](`item ${expectedId}`) };

  const publisher = publisherId ? proofBy(proofs, publisherId, signed) : "verified";
  if (publisher !== "verified") return { ok: false, reason: PROOF_REASONS[publisher](`the store publisher ${publisherId}`) };

  return { ok: true, zip };
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
    if (dir === root && entry.name === LAUNCH_FILE) continue;

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

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/* @invariant A CACHED COPY IS LOADED ONLY WHEN ITS FILES HASH TO WHAT WAS
 * VERIFIED. A bundled copy is compared with the sha256 its record names, and a
 * store copy with the tree of the archive that just passed its CRX3 check
 * (without _metadata), so a folder edited or planted in the cache is rebuilt,
 * never loaded. The cache folders are the person's alone (0700).
 */
function placed(cacheDir: string, name: string, expected: string | null, fill: (into: string) => void): string | null {
  privateDir(cacheDir);

  const target = path.join(cacheDir, name);
  const present = fs.existsSync(path.join(target, "manifest.json"));
  if (expected && present && treeSha256(target) === expected) return target;

  const staging = `${target}.${process.pid}.${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  privateDir(staging);
  fill(staging);

  const built = treeSha256(staging);

  if (expected && built !== expected) {
    fs.rmSync(staging, { recursive: true, force: true });

    return null;
  }

  if (!expected && present && treeSha256(target) === built) {
    fs.rmSync(staging, { recursive: true, force: true });

    return target;
  }

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

  const expected = String(record.sha256[folder] ?? "");

  if (!expected || treeSha256(source) !== expected) {
    return { failed: "the copy of extension.dev tools bundled with this MCP does not match the sha256 its package records" };
  }

  const dir = placed(cacheDir, `bundled-${folder}-${record.version}-${expected.slice(0, 12)}`, expected, (into) => fs.cpSync(source, into, { recursive: true }));
  if (!dir) return { failed: "the copy of extension.dev tools bundled with this MCP changed while it was copied" };

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

  const crx = readCrx3(bytes, TOOLS_ITEMS[store].id, TOOLS_ITEMS[store].publisher);
  if (!crx.ok) return { ok: false, reason: `its download was refused: ${crx.reason}` };

  const manifest = readZipEntry(crx.zip, "manifest.json", { maxEntries: UNPACK_LIMITS.maxEntries, maxBytes: 1024 * 1024 });
  if (!manifest.ok) return { ok: false, reason: `its download holds no readable manifest (${manifest.message})` };

  try {
    return { ok: true, zip: crx.zip, version: String(JSON.parse(manifest.data.toString("utf8")).version ?? "") };
  } catch {
    return { ok: false, reason: "its download holds a manifest that does not parse" };
  }
}

function amoFileHost(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    return url.protocol === "https:" && !url.username && !url.password && (host === "addons.mozilla.org" || host.endsWith(".mozilla.net"));
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type AmoRead = { ok: true; xpi: Buffer; version: string } | { ok: false; reason: string };

/* @invariant A FIREFOX ADD-ONS COPY IS LOADED ONLY WHEN IT IS THE LISTED
 * ADD-ON, AT THE PROTOCOL MINIMUM, FROM MOZILLA, WITH THE HASH AMO NAMES. The
 * public API names the current version, its file address and its sha256; the
 * file is fetched only over https from addons.mozilla.org or a mozilla.net
 * host, must hash to that sha256 and must declare the gecko id
 * sidekick@extension.dev. Anything else loads the bundled copy and says why.
 */
async function readAmo(fetchImpl: typeof fetch): Promise<AmoRead> {
  let listing: unknown;

  try {
    const res = await fetchImpl(AMO_ADDON_API, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.status === 404 || res.status === 401) return { ok: false, reason: "it does not list the add-on yet" };
    if (!res.ok) return { ok: false, reason: `it answered ${res.status}` };

    listing = await res.json();
  } catch (err) {
    return { ok: false, reason: `it could not be reached (${err instanceof Error ? err.message : String(err)})` };
  }

  const current = isObject(listing) && isObject(listing.current_version) ? listing.current_version : {};
  const file = isObject(current.file) ? current.file : {};
  const version = typeof current.version === "string" ? current.version : "";
  const fileUrl = typeof file.url === "string" ? file.url : "";
  const hash = /^sha256:([0-9a-f]{64})$/i.exec(typeof file.hash === "string" ? file.hash : "")?.[1]?.toLowerCase() ?? "";

  if (!version || !fileUrl || !hash) return { ok: false, reason: "its answer names no version, file and sha256" };
  if (compareVersions(version, MIN_TOOLS_VERSION) < 0) return { ok: false, reason: `it serves ${version}, older than ${MIN_TOOLS_VERSION}` };
  if (!amoFileHost(fileUrl)) return { ok: false, reason: "its file address is not an https address on addons.mozilla.org or mozilla.net" };

  let xpi: Buffer;

  try {
    const res = await fetchImpl(fileUrl, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.url && !amoFileHost(res.url)) return { ok: false, reason: "its file redirected off addons.mozilla.org and mozilla.net" };
    if (!res.ok) return { ok: false, reason: `its file answered ${res.status}` };

    xpi = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: `its file could not be reached (${err instanceof Error ? err.message : String(err)})` };
  }

  if (xpi.length > MAX_CRX_BYTES) return { ok: false, reason: `its file is over ${MAX_CRX_BYTES} bytes` };
  if (crypto.createHash("sha256").update(xpi).digest("hex") !== hash) return { ok: false, reason: "its file does not match the sha256 it names" };

  const manifest = readZipEntry(xpi, "manifest.json", { maxEntries: UNPACK_LIMITS.maxEntries, maxBytes: 1024 * 1024 });
  if (!manifest.ok) return { ok: false, reason: `its file holds no readable manifest (${manifest.message})` };

  let declared: unknown;

  try {
    declared = JSON.parse(manifest.data.toString("utf8"));
  } catch {
    return { ok: false, reason: "its file holds a manifest that does not parse" };
  }

  const settings = isObject(declared) && isObject(declared.browser_specific_settings) ? declared.browser_specific_settings : {};
  const gecko = isObject(settings.gecko) ? settings.gecko : {};
  if (gecko.id !== AMO_ADDON_ID) return { ok: false, reason: `its file declares the gecko id ${typeof gecko.id === "string" ? gecko.id : "(none)"}, not ${AMO_ADDON_ID}` };
  if (isObject(declared) && declared.version !== version) return { ok: false, reason: `its file says ${String(declared.version)}, not ${version}` };

  return { ok: true, xpi, version };
}

function unpackedStoreCopy(cacheDir: string, name: string, zip: Buffer, version: string): string | null {
  let unpackFailure = "";

  const dir = placed(cacheDir, name, null, (into) => {
    const unpacked = unpackZip(zip, into, UNPACK_LIMITS);
    if (!unpacked.ok) unpackFailure = unpacked.message;

    fs.rmSync(path.join(into, "_metadata"), { recursive: true, force: true });
  });

  if (dir && !unpackFailure && manifestVersion(dir) === version) return dir;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });

  return null;
}

export async function resolveToolsExtension(options: {
  engine: "chromium" | "gecko";
  edge: boolean;
  cacheDir: string;
  fetchImpl: typeof fetch;
  bundleDir?: string | null;
}): Promise<ToolsExtension | { failed: string }> {
  const bundleDir = options.bundleDir === undefined ? bundledToolsDir() : options.bundleDir;

  if (options.engine === "gecko") {
    const amo = await readAmo(options.fetchImpl);
    if (!amo.ok) return bundledCopy(options.cacheDir, "firefox", bundleDir, `Firefox Add-ons was not used because ${amo.reason}, so `);

    const dir = unpackedStoreCopy(options.cacheDir, `firefox-${amo.version}`, amo.xpi, amo.version);
    if (!dir) return bundledCopy(options.cacheDir, "firefox", bundleDir, "Firefox Add-ons was not used because its file did not unpack, so ");

    return { dir, version: amo.version, source: "firefox", note: `extension.dev tools ${amo.version} comes from Firefox Add-ons.` };
  }

  const store: ToolsStore = options.edge ? "edge" : "chrome";
  const name = TOOLS_ITEMS[store].store;
  const read = await readStore(store, options.fetchImpl);

  if (!read.ok) return bundledCopy(options.cacheDir, "chromium", bundleDir, `${name} was not used because ${read.reason}, so `);

  if (compareVersions(read.version, MIN_TOOLS_VERSION) < 0) {
    return bundledCopy(options.cacheDir, "chromium", bundleDir, `${name} serves ${read.version}, older than ${MIN_TOOLS_VERSION}, so `);
  }

  const dir = unpackedStoreCopy(options.cacheDir, `${store}-${read.version}`, read.zip, read.version);
  if (!dir) return bundledCopy(options.cacheDir, "chromium", bundleDir, `${name} was not used because its download did not unpack, so `);

  return { dir, version: read.version, source: store, note: `extension.dev tools ${read.version} comes from ${name}.` };
}
