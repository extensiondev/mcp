// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;

export interface ZipListing {
  names: string[];
  readable: boolean;
}

const UNREADABLE: ZipListing = { names: [], readable: false };

/* @invariant
 * A zip whose table of contents cannot be read is never reported as empty.
 *
 * This exists so a guard can look inside a packaged artifact rather than only
 * at the loose files beside it, and a guard that answers "no entries" for a
 * zip64 archive, a truncated download or something that is not a zip at all
 * would turn every unreadable artifact into a clean bill of health. Every
 * failure path therefore returns readable:false, and the entry count in the
 * end-of-central-directory record is checked against what was actually walked
 * so a partial walk cannot pass as a whole one. Only the central directory is
 * read, so the cost does not scale with what the archive holds.
 */
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
