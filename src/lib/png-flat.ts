// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

  return c >>> 0;
});

export type PngAlpha = "none" | "channel" | "palette" | "key";

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  alpha: PngAlpha;
}

interface Chunks {
  header: PngHeader;
  palette: Buffer | null;
  transparency: Buffer | null;
  data: Buffer;
}

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

function readChunks(png: Buffer): Chunks | string {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return "not a PNG image";

  let offset = 8;
  let header: PngHeader | null = null;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const data: Buffer[] = [];

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return "a truncated PNG chunk";

    if (type === "IHDR") {
      const colorType = body[9]!;
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8]!,
        colorType,
        interlace: body[12]!,
        alpha: colorType === 4 || colorType === 6 ? "channel" : "none",
      };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") transparency = Buffer.from(body);
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;

    offset += 12 + length;
  }

  if (!header) return "a PNG with no IHDR";
  if (transparency && header.alpha === "none") header.alpha = header.colorType === 3 ? "palette" : "key";

  return { header, palette, transparency, data: Buffer.concat(data) };
}

export function pngHeader(png: Buffer): PngHeader | null {
  const read = readChunks(png);

  return typeof read === "string" ? null : read.header;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer | string {
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return "PNG image data shorter than its size";

  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = y > 0 ? dst - stride : -1;

    for (let x = 0; x < stride; x++) {
      const byte = raw[src + x]!;
      const left = x >= bpp ? out[dst + x - bpp]! : 0;
      const up = prev >= 0 ? out[prev + x]! : 0;
      const upLeft = prev >= 0 && x >= bpp ? out[prev + x - bpp]! : 0;
      let value: number;

      if (filter === 0) value = byte;
      else if (filter === 1) value = byte + left;
      else if (filter === 2) value = byte + up;
      else if (filter === 3) value = byte + ((left + up) >> 1);
      else if (filter === 4) value = byte + paeth(left, up, upLeft);
      else return `PNG filter type ${filter} is not one this reader takes`;

      out[dst + x] = value & 0xff;
    }
  }

  return out;
}

function toRgb(chunks: Chunks, pixels: Buffer): Buffer {
  const { width, height, colorType } = chunks.header;
  const rgb = Buffer.alloc(width * height * 3);
  const key = chunks.transparency;
  const paletteAlpha = (index: number): number => (key && index < key.length ? key[index]! : 255);
  const blend = (value: number, alpha: number): number => Math.round((value * alpha + 255 * (255 - alpha)) / 255);

  for (let i = 0; i < width * height; i++) {
    let r: number;
    let g: number;
    let b: number;
    let a = 255;

    if (colorType === 6) {
      r = pixels[i * 4]!;
      g = pixels[i * 4 + 1]!;
      b = pixels[i * 4 + 2]!;
      a = pixels[i * 4 + 3]!;
    } else if (colorType === 4) {
      r = pixels[i * 2]!;
      g = r;
      b = r;
      a = pixels[i * 2 + 1]!;
    } else if (colorType === 3) {
      const index = pixels[i]!;
      const palette = chunks.palette ?? Buffer.alloc(0);
      r = palette[index * 3] ?? 0;
      g = palette[index * 3 + 1] ?? 0;
      b = palette[index * 3 + 2] ?? 0;
      a = paletteAlpha(index);
    } else if (colorType === 2) {
      r = pixels[i * 3]!;
      g = pixels[i * 3 + 1]!;
      b = pixels[i * 3 + 2]!;
      if (key && key.length >= 6 && r === key.readUInt16BE(0) && g === key.readUInt16BE(2) && b === key.readUInt16BE(4)) a = 0;
    } else {
      r = pixels[i]!;
      g = r;
      b = r;
      if (key && key.length >= 2 && r === key.readUInt16BE(0)) a = 0;
    }

    rgb[i * 3] = blend(r, a);
    rgb[i * 3 + 1] = blend(g, a);
    rgb[i * 3 + 2] = blend(b, a);
  }

  return rgb;
}

function encodeRgb(width: number, height: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export type Flattened = { png: Buffer; hadAlpha: boolean; width: number; height: number } | { problem: string };

/* @invariant A STORE IMAGE IS THE PAGE'S OWN PIXELS ON WHITE, NEVER A
 * REPAINT. Every pixel the browser answered is kept; only its transparency is
 * composited onto white, the way a store that takes no alpha channel would
 * show it, and the result is written as 8-bit RGB (24-bit, color type 2),
 * the one form Chrome, Edge, Firefox and the App Store all accept. An image
 * with no transparency is returned byte for byte, and a form this reader
 * does not take (16-bit samples, an interlaced image) is named as a problem
 * rather than guessed at.
 */
export function flattenPngAlpha(png: Buffer): Flattened {
  const chunks = readChunks(png);
  if (typeof chunks === "string") return { problem: chunks };

  const { header } = chunks;
  const { width, height } = header;

  if (header.alpha === "none") return { png, hadAlpha: false, width, height };
  if (header.bitDepth !== 8) return { problem: `a ${header.bitDepth}-bit PNG; this reader flattens 8-bit images` };
  if (header.interlace !== 0) return { problem: "an interlaced PNG; this reader flattens non-interlaced images" };

  const channels = CHANNELS[header.colorType];
  if (!channels) return { problem: `PNG color type ${header.colorType} is not one this reader takes` };

  let raw: Buffer;

  try {
    raw = zlib.inflateSync(chunks.data);
  } catch (error) {
    return { problem: `PNG image data could not be inflated: ${error instanceof Error ? error.message : String(error)}` };
  }

  const pixels = unfilter(raw, width, height, channels);
  if (typeof pixels === "string") return { problem: pixels };

  return { png: encodeRgb(width, height, toRgb(chunks, pixels)), hadAlpha: true, width, height };
}
