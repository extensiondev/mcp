// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* @invariant A MANIFEST key FIXES THE ID, WHATEVER FOLDER HOLDS THE BUILD.
 * Chromium gives an extension whose manifest carries `key` the ID made from
 * that key: the SHA-256 of the DER public key bytes the base64 decodes to,
 * its first 16 bytes, each hex nibble spelled a to p. The folder rule applies
 * only to a manifest with no key. On 2026-11-18 (ledger 936) extension_start
 * and extension_open hashed the folder for a project with a key, so the start
 * answer named an ID no browser had and the surface open went to it and was
 * refused. This file is the one place the key rule is written; the ID is read
 * from the manifest in the folder the browser loads, never from the source.
 */
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PEM_ARMOR = /-----(BEGIN|END)[^-]*-----/g;

export function keyExtensionId(key: unknown): string | null {
  if (typeof key !== "string") return null;

  const body = key.startsWith("-----BEGIN") ? key.replace(PEM_ARMOR, "").replace(/\s+/g, "") : key;
  if (body.length === 0 || body.length % 4 !== 0 || !STRICT_BASE64.test(body)) return null;

  const digest = createHash("sha256").update(Buffer.from(body, "base64")).digest();
  let id = "";

  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i]! >> 4));
    id += String.fromCharCode(97 + (digest[i]! & 0x0f));
  }

  return id;
}

export function manifestKeyExtensionId(dir: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { key?: unknown };

    return keyExtensionId(manifest?.key);
  } catch {
    return null;
  }
}
