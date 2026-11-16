// VENDORED FILE - DO NOT HAND-EDIT.
//
// Synced verbatim from packages/emulator/src/browser-ui/lib/chrome-theme-color-math.ts
// by public/mcp/scripts/sync-chrome-theme-vendor.mjs.
//
// The published @extension.dev/mcp must not take a workspace dependency on
// @extension.dev/emulator (the carrier ships decoupled), so this pure resolver
// is copied in. Edit the emulator source, then re-run the sync script.

// ███████╗███╗   ███╗██╗   ██╗██╗      █████╗ ████████╗ ██████╗ ██████╗
// ██╔════╝████╗ ████║██║   ██║██║     ██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
// █████╗  ██╔████╔██║██║   ██║██║     ███████║   ██║   ██║   ██║██████╔╝
// ██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██╔══██║   ██║   ██║   ██║██╔══██╗
// ███████╗██║ ╚═╝ ██║╚██████╔╝███████╗██║  ██║   ██║   ╚██████╔╝██║  ██║
// ╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HslTint {
  h: number;
  s: number;
  l: number;
}

export const DARKEST_COLOR: RgbaColor = { r: 0x20, g: 0x21, b: 0x24, a: 255 };

export const LUMINANCE_MIDPOINT = 0.211692036;

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

export function clampRound(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function linearize(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: RgbaColor): number {
  return (
    0.2126 * linearize(color.r / 255) +
    0.7152 * linearize(color.g / 255) +
    0.0722 * linearize(color.b / 255)
  );
}

export function contrastRatioFromLuminance(a: number, b: number): number {
  const la = a + 0.05;
  const lb = b + 0.05;
  return la > lb ? la / lb : lb / la;
}

export function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  return contrastRatioFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

export function isDarkChromium(color: RgbaColor): boolean {
  return relativeLuminance(color) < LUMINANCE_MIDPOINT;
}

export function getColorWithMaxContrast(color: RgbaColor): RgbaColor {
  return isDarkChromium(color) ? rgba(255, 255, 255) : { ...DARKEST_COLOR };
}

export function getEndpointColorWithMinContrast(color: RgbaColor): RgbaColor {
  return isDarkChromium(color) ? { ...DARKEST_COLOR } : rgba(255, 255, 255);
}

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

function calcHue(temp1: number, temp2: number, hue: number): number {
  if (hue < 0) hue += 1;
  else if (hue > 1) hue -= 1;
  let result = temp1;
  if (hue * 6 < 1) result = temp1 + (temp2 - temp1) * hue * 6;
  else if (hue * 2 < 1) result = temp2;
  else if (hue * 3 < 2) result = temp1 + (temp2 - temp1) * (2 / 3 - hue) * 6;
  return clampRound(result * 255);
}

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

/* @invariant
 * THE SIGNED-OUT AVATAR TAKES ITS STROKE FROM THE FRAME. SOURCE-READ at
 * refs/tags/156.0.8065.0: the placeholder avatar is drawn in the profile's
 * default_avatar_stroke_color (profile_avatar_icon_util.cc:923-955 through
 * avatar_toolbar_button_state_manager.cc:197-201 and
 * profile_colors_util.cc:41-53, :170-176 on kColorFrameActiveUnthemed), and
 * GetDefaultAvatarColors (:223-246) takes kColorAvatarStroke, which is
 * kColorToolbarButtonIcon (chrome_color_mixer.cc:385), when the frame is
 * dark by IsDark (color_utils.cc:617-619 at the 0.211692036 midpoint) and
 * otherwise the frame with its HSL lightness lowered by 0.5. MEASURED on
 * window-idle-light-glassoff.chrome-156.0.8065.0.active.png: the glyph raw
 * 10,82,200 on the #d3e3fd frame, the unit this port computes; on the dark
 * capture 194,195,203, the icon tone (D-LIGHTAVATAR-156-1).
 */
export function avatarPlaceholderStroke(
  frame: RgbaColor,
  iconTone: RgbaColor,
): RgbaColor {
  if (isDarkChromium(frame)) return iconTone;
  const hsl = skColorToHsl(frame);
  hsl.l = Math.max(0, hsl.l - 0.5);
  return hslToSkColor(hsl, frame.a);
}

export function makeHslShiftValid(tint: HslTint): HslTint {
  return {
    h: tint.h < 0 || tint.h > 1 ? -1 : tint.h,
    s: tint.s < 0 || tint.s > 1 ? -1 : tint.s,
    l: tint.l < 0 || tint.l > 1 ? -1 : tint.l,
  };
}

export const HSL_NO_TINT: HslTint = { h: -1, s: -1, l: -1 };

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

export function isColorGrayscale(color: RgbaColor): boolean {
  const channels = [color.r, color.g, color.b];
  return Math.max(...channels) - Math.min(...channels) < 9;
}
