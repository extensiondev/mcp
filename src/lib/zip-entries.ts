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

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipListing {
  names: string[];
  readable: boolean;
}

const UNREADABLE: ZipListing = { names: [], readable: false };

export function readZipEntryNames(zipPath: string): ZipListing {
  let handle: number | null = null;

  try {
    const size = fs.statSync(zipPath).size;
    if (size < EOCD_MIN_LENGTH) return UNREADABLE;

    handle = fs.openSync(zipPath, "r");

    const tailLength = Math.min(size, MAX_COMMENT_LENGTH + EOCD_MIN_LENGTH);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(handle, tail, 0, tailLength, size - tailLength);

    let eocd = -1;

    for (let at = tail.length - EOCD_MIN_LENGTH; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }

    if (eocd < 0) return UNREADABLE;

    const expected = tail.readUInt16LE(eocd + 10);
    const directoryBytes = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);

    if (
      expected === 0xffff ||
      directoryBytes === 0xffffffff ||
      directoryOffset === 0xffffffff ||
      directoryBytes > MAX_DIRECTORY_BYTES ||
      directoryOffset + directoryBytes > size
    ) {
      return UNREADABLE;
    }

    if (directoryBytes === 0) {
      return { names: [], readable: expected === 0 };
    }

    const directory = Buffer.alloc(directoryBytes);
    fs.readSync(handle, directory, 0, directoryBytes, directoryOffset);

    const names: string[] = [];
    let at = 0;

    while (at + 46 <= directory.length) {
      if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) return UNREADABLE;

      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const nameStart = at + 46;
      if (nameStart + nameLength > directory.length) return UNREADABLE;

      names.push(
        directory.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      );

      at = nameStart + nameLength + extraLength + commentLength;
    }

    return { names, readable: names.length === expected };
  } catch {
    return UNREADABLE;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
      }
    }
  }
}

export type ZipUnpack = { ok: true; files: number; bytes: number } | { ok: false; message: string };

function safeEntryPath(intoDir: string, name: string): string | null {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  if (name.split("/").some((segment) => segment === "..")) return null;

  const target = path.resolve(intoDir, name);

  return target.startsWith(path.resolve(intoDir) + path.sep) ? target : null;
}

/* @invariant AN ARCHIVE NEVER WRITES OUTSIDE THE FOLDER IT IS UNPACKED INTO.
 * A build zip comes from the network, so an entry naming an absolute path, a
 * drive, a backslash or a ".." segment refuses the whole archive before any
 * byte is written, and the entry count and unpacked size are capped so a
 * small download cannot fill the disk.
 */
export function unpackZip(
  bytes: Buffer,
  intoDir: string,
  limits: { maxEntries: number; maxBytes: number },
): ZipUnpack {
  if (bytes.length < EOCD_MIN_LENGTH) return { ok: false, message: "the archive is too short to be a zip" };

  let eocd = -1;
  const floor = Math.max(0, bytes.length - (MAX_COMMENT_LENGTH + EOCD_MIN_LENGTH));

  for (let at = bytes.length - EOCD_MIN_LENGTH; at >= floor; at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }

  if (eocd < 0) return { ok: false, message: "the archive has no zip directory" };

  const count = bytes.readUInt16LE(eocd + 10);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);

  if (count > limits.maxEntries) return { ok: false, message: `the archive holds ${count} entries, over the ${limits.maxEntries} allowed` };

  const entries: Array<{ name: string; method: number; compressed: number; size: number; offset: number }> = [];
  let at = directoryOffset;

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      return { ok: false, message: "the zip directory is damaged" };
    }

    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    entries.push({
      name,
      method: bytes.readUInt16LE(at + 10),
      compressed: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 24),
      offset: bytes.readUInt32LE(at + 42),
    });

    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }

  let total = 0;

  for (const entry of entries) {
    const checked = entry.name.replace(/\/+$/, "");

    if (checked !== "" && checked !== "." && !safeEntryPath(intoDir, checked)) {
      return { ok: false, message: `the archive entry "${entry.name}" points outside the folder it unpacks into` };
    }

    if (entry.method !== 0 && entry.method !== 8) {
      return { ok: false, message: `the archive entry "${entry.name}" uses compression method ${entry.method}, which this tool does not read` };
    }

    total += entry.size;
  }

  if (total > limits.maxBytes) return { ok: false, message: `the archive unpacks to ${total} bytes, over the ${limits.maxBytes} allowed` };

  let files = 0;
  let written = 0;

  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;

    const target = safeEntryPath(intoDir, entry.name) as string;
    const local = entry.offset;

    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      return { ok: false, message: `the archive entry "${entry.name}" is damaged` };
    }

    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + entry.compressed);
    let data: Buffer;

    try {
      data = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : Buffer.from(raw);
    } catch (err: any) {
      return { ok: false, message: `the archive entry "${entry.name}" could not be unpacked: ${err?.message || err}` };
    }

    if (data.length !== entry.size) {
      return { ok: false, message: `the archive entry "${entry.name}" unpacked to ${data.length} bytes, not the ${entry.size} its directory records` };
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files += 1;
    written += data.length;
  }

  return { ok: true, files, bytes: written };
}
