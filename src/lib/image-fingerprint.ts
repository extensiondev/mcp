// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngPixels(bytes: Buffer): { width: number; height: number; rgb: Buffer } | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  const data: Buffer[] = [];

  for (let at = 8; at + 12 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + size);

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      color = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;

    at += 12 + size;
  }

  const channels = color === 2 ? 3 : color === 6 ? 4 : 0;
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height) return null;

  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const rgb = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = prev[x]!;
      const corner = x >= channels ? prev[x - channels]! : 0;
      const add = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;

      line[x] = (line[x]! + add) & 0xff;
    }

    for (let x = 0; x < width; x += 1) line.copy(rgb, (y * width + x) * 3, x * channels, x * channels + 3);

    prev = line;
  }

  return { width, height, rgb };
}

export function imageFingerprint(bytes: Buffer): string {
  try {
    const decoded = pngPixels(bytes);

    if (decoded) return `rgb:${decoded.width}x${decoded.height}:${crypto.createHash("sha256").update(decoded.rgb).digest("hex")}`;
  } catch {}

  return `bytes:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
