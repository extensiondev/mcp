// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { pngAlphaPlane, pngHeader } from "./png-flat";

export const CHROME_ICON_RULE_URL = "https://developer.chrome.com/docs/webstore/images";

const CANVAS = 128;
const OPAQUE_ABOVE = 24;
const ROUND_FILL_BELOW = 0.88;
const SQUARE_ART = { min: 88, max: 104 };
const ROUND_ART = { min: 104, max: 116 };
const SQUARE_MIN_SIDE = 8;
const ROUND_MIN_SIDE = 4;
const MAX_ICON_BYTES = 512 * 1024;

export type ArtShape = "square" | "round";

export interface IconArt {
  width: number;
  height: number;
  padding: { left: number; right: number; top: number; bottom: number };
  shape: ArtShape;
}

export interface ChromeIconPadding {
  source: string;
  art: IconArt | null;
  fits: boolean;
  say: string;
}

export function measureIconArt(png: Buffer): IconArt | { empty: true } | { problem: string } {
  const plane = pngAlphaPlane(png);
  if ("problem" in plane) return plane;

  const { width, height, alpha } = plane;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let opaque = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x]! <= OPAQUE_ABOVE) continue;

      opaque++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0) return { empty: true };

  const artWidth = right - left + 1;
  const artHeight = bottom - top + 1;
  const fill = opaque / (artWidth * artHeight);
  const corner = alpha[top * width + left]! <= OPAQUE_ABOVE && alpha[bottom * width + right]! <= OPAQUE_ABOVE;

  return {
    width: artWidth,
    height: artHeight,
    padding: { left, right: width - 1 - right, top, bottom: height - 1 - bottom },
    shape: corner && fill < ROUND_FILL_BELOW ? "round" : "square",
  };
}

function paddingWords(padding: IconArt["padding"]): string {
  const sides = [padding.left, padding.right, padding.top, padding.bottom];

  if (sides.every((side) => side === sides[0])) return `${sides[0]} px of padding per side`;

  return `padding of ${padding.left} px left, ${padding.right} px right, ${padding.top} px top and ${padding.bottom} px bottom`;
}

function fitsRule(art: IconArt): boolean {
  const side = Math.max(art.width, art.height);
  const least = Math.min(art.padding.left, art.padding.right, art.padding.top, art.padding.bottom);
  const range = art.shape === "round" ? ROUND_ART : SQUARE_ART;

  return side >= range.min && side <= range.max && least >= (art.shape === "round" ? ROUND_MIN_SIDE : SQUARE_MIN_SIDE);
}

function looksLike(art: IconArt): string {
  const side = Math.max(art.width, art.height);
  const range = art.shape === "round" ? ROUND_ART : SQUARE_ART;

  if (side > range.max) return "a tile that looks larger than its neighbors in the store and on chrome://extensions";
  if (side < range.min) return "a mark that looks smaller than its neighbors in the store and on chrome://extensions";

  return "a mark that sits off center in the store and on chrome://extensions";
}

const RULE_SENTENCE =
  "The Chrome Web Store asks for 96x96 art with 16 px of transparent padding per side on the 128 px icon (squarish art 75 to 80 percent of the width, round art about 112 px across)";

const TAIL_SENTENCE = `The 16, 32 and 48 px icons need no padding. Chrome does not refuse the upload over this; it is advice (${CHROME_ICON_RULE_URL}).`;

export function chromeIconPadding(png: Buffer, source: string): ChromeIconPadding | null {
  const header = pngHeader(png);
  if (!header || header.width !== CANVAS || header.height !== CANVAS) return null;

  const measured = measureIconArt(png);
  if ("problem" in measured) return null;

  if ("empty" in measured) {
    return { source, art: null, fits: false, say: `${source}, the 128 px icon, is fully transparent, so the store shows no mark. ${RULE_SENTENCE}. ${TAIL_SENTENCE}` };
  }

  if (fitsRule(measured)) return null;

  const fix = measured.shape === "round"
    ? "resize the circle to about 112 px across and center it on the 128 px canvas"
    : "resize the art to 96 px and extend 16 px of transparent canvas per side";

  return {
    source,
    art: measured,
    fits: false,
    say: `${source}, the 128 px icon, has ${measured.shape} art ${measured.width}x${measured.height} with ${paddingWords(measured.padding)}. ${RULE_SENTENCE}, so as it is the store shows ${looksLike(measured)}; ${fix}. ${TAIL_SENTENCE}`,
  };
}

export function chromeIconPaddingOfFile(file: string, source: string): ChromeIconPadding | null {
  let bytes: Buffer;

  try {
    if (fs.statSync(file).size > MAX_ICON_BYTES) return null;

    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }

  return chromeIconPadding(bytes, source || path.basename(file));
}

export function iconPaddingView(store: string, icons: Array<{ bytes: Buffer; source: string }> | undefined): { iconPadding: ChromeIconPadding } | Record<string, never> {
  const icon = store === "chrome" ? icons?.[0] : undefined;
  const padding = icon ? chromeIconPadding(icon.bytes, icon.source) : null;

  return padding ? { iconPadding: padding } : {};
}

export function iconPaddingSentences(stores: Record<string, unknown>): string {
  return Object.values(stores)
    .map((view) => (view && typeof view === "object" ? (view as { iconPadding?: ChromeIconPadding }).iconPadding?.say : undefined))
    .filter((say): say is string => Boolean(say))
    .join(" ");
}
