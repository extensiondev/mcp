// VENDORED FILE - DO NOT HAND-EDIT.
//
// Synced verbatim from packages/extensiondev-emulator/src/browser-ui/lib/chrome-theme-color-math.ts
// by packages/public-extensiondev-mcp/scripts/sync-chrome-theme-vendor.mjs.
//
// The published @extension.dev/mcp must not take a workspace dependency on
// @extension.dev/emulator (the carrier ships decoupled), so this pure resolver
// is copied in. Edit the emulator source, then re-run the sync script.

/**
 * Exact TypeScript ports of the Chromium color math used by the browser
 * theme pipeline (ui/gfx/color_utils.cc, refs/heads/main, cached under
 * parity/chromium-src-cache, fetched 2026-07-04).
 *
 * Every function mirrors its Chromium namesake so the theme resolver can
 * reproduce Chrome's derived colors bit-for-bit. When editing, re-read the
 * cited source instead of "fixing" the math: several rules (HSL lightness
 * shift in RGB space, the luminance midpoint, alpha normalization) are
 * deliberately not the textbook versions.
 */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  /** 0..255, like SkColor. */
  a: number;
}

/** HSL tint triple; -1 in a channel means "leave unchanged". */
export interface HslTint {
  h: number;
  s: number;
  l: number;
}

/** color_utils.cc:35 g_darkest_color = gfx::kGoogleGrey900. */
export const DARKEST_COLOR: RgbaColor = { r: 0x20, g: 0x21, b: 0x24, a: 255 };

/**
 * color_utils.cc:40 g_luminance_midpoint: the luminance where white and
 * kGoogleGrey900 contrast equally. IsDark() pivots here, NOT at 0.5.
 */
export const LUMINANCE_MIDPOINT = 0.211692036;

/** color_utils.cc kMinimumReadableContrastRatio. */
export const MINIMUM_READABLE_CONTRAST_RATIO = 4.5;

export function rgba(r: number, g: number, b: number, a = 255): RgbaColor {
  return { r, g, b, a };
}

export function parseHexColor(hex: string): RgbaColor {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized,
    16,
  );
  if (Number.isNaN(value)) return { r: 0, g: 0, b: 0, a: 255 };
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
    a: 255,
  };
}

export function toHexColor(color: RgbaColor): string {
  const to2 = (v: number) => v.toString(16).padStart(2, "0");
  return `#${to2(color.r)}${to2(color.g)}${to2(color.b)}`;
}

/** base::ClampRound for the 0..255 channel domain. */
export function clampRound(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** color_utils.cc:62 Linearize (sRGB, the 0.04045 variant). */
function linearize(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4;
}

/** color_utils.cc:425 GetRelativeLuminance4f. */
export function relativeLuminance(color: RgbaColor): number {
  return (
    0.2126 * linearize(color.r / 255) +
    0.7152 * linearize(color.g / 255) +
    0.0722 * linearize(color.b / 255)
  );
}

/** color_utils.cc:412 GetContrastRatio (luminance form). */
export function contrastRatioFromLuminance(a: number, b: number): number {
  const la = a + 0.05;
  const lb = b + 0.05;
  return la > lb ? la / lb : lb / la;
}

/** color_utils.cc:402 GetContrastRatio. */
export function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  return contrastRatioFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

/** color_utils.cc:617 IsDark: luminance below the grey900/white midpoint. */
export function isDarkChromium(color: RgbaColor): boolean {
  return relativeLuminance(color) < LUMINANCE_MIDPOINT;
}

/** color_utils.cc:621 GetColorWithMaxContrast: white or kGoogleGrey900. */
export function getColorWithMaxContrast(color: RgbaColor): RgbaColor {
  return isDarkChromium(color) ? rgba(255, 255, 255) : { ...DARKEST_COLOR };
}

/** color_utils.cc:625 GetEndpointColorWithMinContrast. */
export function getEndpointColorWithMinContrast(color: RgbaColor): RgbaColor {
  return isDarkChromium(color) ? { ...DARKEST_COLOR } : rgba(255, 255, 255);
}

/** color_utils.cc:436 SkColorToHSL. */
export function skColorToHsl(color: RgbaColor): HslTint {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const vmax = Math.max(r, g, b);
  const vmin = Math.min(r, g, b);
  const delta = vmax - vmin;
  const l = (vmax + vmin) / 2;
  if (color.r === color.g && color.r === color.b) {
    return { h: 0, s: 0, l };
  }
  const dr = ((vmax - r) / 6 + delta / 2) / delta;
  const dg = ((vmax - g) / 6 + delta / 2) / delta;
  const db = ((vmax - b) / 6 + delta / 2) / delta;
  let h: number;
  if (r >= g && r >= b) h = db - dg;
  else if (g >= r && g >= b) h = 1 / 3 + dr - db;
  else h = 2 / 3 + dg - dr;
  if (h < 0) h += 1;
  else if (h > 1) h -= 1;
  const s = delta / (l < 0.5 ? vmax + vmin : 2 - vmax - vmin);
  return { h, s, l };
}

/** color_utils.cc:44 calcHue. */
function calcHue(temp1: number, temp2: number, hue: number): number {
  if (hue < 0) hue += 1;
  else if (hue > 1) hue -= 1;
  let result = temp1;
  if (hue * 6 < 1) result = temp1 + (temp2 - temp1) * hue * 6;
  else if (hue * 2 < 1) result = temp2;
  else if (hue * 3 < 2) result = temp1 + (temp2 - temp1) * (2 / 3 - hue) * 6;
  return clampRound(result * 255);
}

/** color_utils.cc:467 HSLToSkColor. */
export function hslToSkColor(hsl: HslTint, alpha: number): RgbaColor {
  const { h, s, l } = hsl;
  if (!s) {
    const light = clampRound(l * 255);
    return rgba(light, light, light, alpha);
  }
  const temp2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const temp1 = 2 * l - temp2;
  return rgba(
    calcHue(temp1, temp2, h + 1 / 3),
    calcHue(temp1, temp2, h),
    calcHue(temp1, temp2, h - 1 / 3),
    alpha,
  );
}

/** color_utils.cc:518 MakeHSLShiftValid: out-of-range channels become -1. */
export function makeHslShiftValid(tint: HslTint): HslTint {
  return {
    h: tint.h < 0 || tint.h > 1 ? -1 : tint.h,
    s: tint.s < 0 || tint.s > 1 ? -1 : tint.s,
    l: tint.l < 0 || tint.l > 1 ? -1 : tint.l,
  };
}

/** A tint that leaves the color unchanged. */
export const HSL_NO_TINT: HslTint = { h: -1, s: -1, l: -1 };

/**
 * color_utils.cc:534 HSLShift, Chrome's tint operation. NOT a plain HSL
 * replacement: hue is replaced, saturation is scaled around 0.5, and the
 * lightness shift happens in RGB space ("in the style of popular image
 * editors").
 */
export function hslShift(color: RgbaColor, shift: HslTint): RgbaColor {
  const alpha = color.a;
  let working = { ...color };

  if (shift.h >= 0 || shift.s >= 0) {
    const hsl = skColorToHsl(working);
    if (shift.h >= 0) hsl.h = shift.h;
    if (shift.s >= 0) {
      if (shift.s <= 0.5) hsl.s *= shift.s * 2;
      else hsl.s += (1 - hsl.s) * ((shift.s - 0.5) * 2);
    }
    working = hslToSkColor(hsl, alpha);
  }

  if (shift.l < 0) return working;

  let { r, g, b } = working;
  if (shift.l <= 0.5) {
    r *= shift.l * 2;
    g *= shift.l * 2;
    b *= shift.l * 2;
  } else {
    r += (255 - r) * ((shift.l - 0.5) * 2);
    g += (255 - g) * ((shift.l - 0.5) * 2);
    b += (255 - b) * ((shift.l - 0.5) * 2);
  }
  return rgba(clampRound(r), clampRound(g), clampRound(b), alpha);
}

/**
 * color_utils.cc:581 AlphaBlend(float): weights each side by its own alpha
 * times the blend factor (a foreground with alpha participates less).
 */
export function alphaBlend(
  foreground: RgbaColor,
  background: RgbaColor,
  alpha: number,
): RgbaColor {
  if (alpha === 0) return { ...background };
  if (alpha === 1) return { ...foreground };
  const fAlpha = foreground.a;
  const bAlpha = background.a;
  const normalizer = fAlpha * alpha + bAlpha * (1 - alpha);
  if (normalizer === 0) return rgba(0, 0, 0, 0);
  const fWeight = (fAlpha * alpha) / normalizer;
  const bWeight = (bAlpha * (1 - alpha)) / normalizer;
  return rgba(
    clampRound(foreground.r * fWeight + background.r * bWeight),
    clampRound(foreground.g * fWeight + background.g * bWeight),
    clampRound(foreground.b * fWeight + background.b * bWeight),
    clampRound(normalizer),
  );
}

/** color_utils.cc:612 GetResultingPaintColor: composite fg over opaque bg. */
export function getResultingPaintColor(
  foreground: RgbaColor,
  background: RgbaColor,
): RgbaColor {
  return alphaBlend(
    { ...foreground, a: 255 },
    background,
    foreground.a / 255,
  );
}

export interface BlendResult {
  alpha: number;
  color: RgbaColor;
}

/**
 * color_utils.cc:647 BlendForMinContrast: binary-search the smallest blend
 * of the target foreground into the default foreground that reaches
 * `targetContrastRatio` against `background`.
 */
export function blendForMinContrast(
  defaultForeground: RgbaColor,
  background: RgbaColor,
  highContrastForeground?: RgbaColor,
  targetContrastRatio = MINIMUM_READABLE_CONTRAST_RATIO,
): BlendResult {
  const paintedDefault = getResultingPaintColor(defaultForeground, background);
  if (contrastRatio(paintedDefault, background) >= targetContrastRatio) {
    return { alpha: 0, color: paintedDefault };
  }
  const targetForeground = getResultingPaintColor(
    highContrastForeground ?? getColorWithMaxContrast(background),
    background,
  );
  const backgroundLuminance = relativeLuminance(background);

  let bestAlpha = 255;
  let bestColor = targetForeground;
  for (let low = 0, high = 256; low < high; ) {
    const alpha = (low + high) >> 1;
    const color = alphaBlend(targetForeground, paintedDefault, alpha / 255);
    const contrast = contrastRatioFromLuminance(
      relativeLuminance(color),
      backgroundLuminance,
    );
    if (contrast >= targetContrastRatio) {
      bestAlpha = alpha;
      bestColor = color;
      high = alpha;
    } else {
      low = alpha + 1;
    }
  }
  return { alpha: bestAlpha, color: bestColor };
}

/** browser_theme_pack.cc:605 IsColorGrayscale: channel range under 9. */
export function isColorGrayscale(color: RgbaColor): boolean {
  const channels = [color.r, color.g, color.b];
  return Math.max(...channels) - Math.min(...channels) < 9;
}
