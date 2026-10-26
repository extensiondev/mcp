import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { flattenPngAlpha, pngHeader } from "../lib/png-flat";
import { clearsStoreRow, pickStoreSize, STORE_SCREENSHOT_SPECS, storeSizeSentence } from "../lib/store-screenshot-sizes";
import { rgbaPng } from "./fixtures/png-alpha";
import { solidPng } from "./fixtures/png";

function inflatePixels(png: Buffer): Buffer {
  let offset = 8;
  const data: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") data.push(png.subarray(offset + 8, offset + 8 + length));

    offset += 12 + length;
  }

  return zlib.inflateSync(Buffer.concat(data));
}

describe("flattenPngAlpha composites a capture onto white as 24-bit RGB", () => {
  it("turns an RGBA capture into color type 2 at the same size, blending half-transparent pixels toward white", () => {
    const png = rgbaPng(4, 2, [10, 20, 30, 128]);

    expect(pngHeader(png)).toMatchObject({ width: 4, height: 2, colorType: 6, alpha: "channel" });

    const flat = flattenPngAlpha(png);
    if ("problem" in flat) throw new Error(flat.problem);

    expect(flat).toMatchObject({ hadAlpha: true, width: 4, height: 2 });
    expect(pngHeader(flat.png)).toMatchObject({ width: 4, height: 2, colorType: 2, bitDepth: 8, alpha: "none" });

    const raw = inflatePixels(flat.png);

    expect(raw.length).toBe((4 * 3 + 1) * 2);
    expect([raw[1], raw[2], raw[3]]).toEqual([132, 137, 142]);
  });

  it("returns an opaque RGB image byte for byte and names a form it does not take", () => {
    const rgb = solidPng(3, 3);
    const same = flattenPngAlpha(rgb);
    if ("problem" in same) throw new Error(same.problem);

    expect(same.hadAlpha).toBe(false);
    expect(same.png.equals(rgb)).toBe(true);
    expect(flattenPngAlpha(Buffer.from("not a png"))).toEqual({ problem: "not a PNG image" });
  });
});

describe("the store screenshot table", () => {
  it("defaults to 1280x800 for every store, takes only a size the store accepts, and judges alpha per store", () => {
    for (const store of ["chrome", "firefox", "edge", "safari"] as const) {
      expect(pickStoreSize(store)).toEqual({ ok: true, width: 1280, height: 800 });
      expect(clearsStoreRow(store, 1280, 800, false)).toEqual({ clears: true });
      expect(STORE_SCREENSHOT_SPECS[store].docs).toMatch(/^https:\/\//);
    }

    expect(pickStoreSize("chrome", 640, 400)).toEqual({ ok: true, width: 640, height: 400 });
    expect(pickStoreSize("chrome", 640, 480)).toMatchObject({ ok: false, message: expect.stringContaining("1280x800, 640x400") });
    expect(clearsStoreRow("chrome", 1280, 800, true)).toEqual({ clears: false, reason: "the Chrome Web Store refuses an alpha channel" });
    expect(clearsStoreRow("edge", 1280, 800, true)).toEqual({ clears: true });
    expect(clearsStoreRow("safari", 1366, 683, false)).toMatchObject({ clears: false, reason: expect.stringContaining("1280x800, 1440x900, 2560x1600, 2880x1800") });
    expect(storeSizeSentence("safari")).toBe("the App Store takes 1 to 10 screenshots at 1280x800 or 1440x900 or 2560x1600 or 2880x1800 px, 24-bit PNG or JPEG with no alpha (https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications).");
  });
});
