// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface Discarded {
  slot: string;
  reason: string;
}

export function discardedProperties(properties: Record<string, unknown>): Discarded[] {
  const out: Discarded[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (key === "ntp_logo_alternate" && typeof value !== "number") {
      out.push({
        slot: `properties.${key}`,
        reason:
          "not a number (Chrome reads 0 or 1), the logo falls back to the derived default",
      });
    }

    if (
      (key === "ntp_background_alignment" || key === "ntp_background_repeat") &&
      typeof value !== "string"
    ) {
      out.push({
        slot: `properties.${key}`,
        reason: "not a string, Chrome falls back to the default",
      });
    }
  }

  return out;
}

export interface ChromeThemeRefusal {
  slot: string;
  write: string | null;
}

export const CHROME_SAYS_BAD_COLORS = "Invalid value for theme colors - colors must be integers";
export const CHROME_SAYS_BAD_TINTS = "Invalid value for theme images - tints must be decimal numbers.";

function alphaOf(byte: number): number {
  return Math.round((byte / 255) * 100) / 100;
}

function arrayForCssColor(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];

  if (hex) {
    const pairs = hex.length <= 4 ? [...hex].map((digit) => digit + digit) : (hex.match(/../g) ?? []);
    const [r, g, b, a] = pairs.map((pair) => Number.parseInt(pair, 16));

    return a === undefined ? `[${r}, ${g}, ${b}]` : `[${r}, ${g}, ${b}, ${alphaOf(a)}]`;
  }

  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*(0|1|0?\.\d+)\s*)?\)$/.exec(text);

  if (rgb && rgb.slice(1, 4).every((channel) => Number(channel) <= 255)) {
    return `[${rgb.slice(1, 4).map(Number).join(", ")}${rgb[4] === undefined ? "" : `, ${Number(rgb[4])}`}]`;
  }

  return null;
}

function isChromeColor(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    value.slice(0, 3).every((channel) => Number.isInteger(channel)) &&
    (value.length === 3 || typeof value[3] === "number")
  );
}

function isChromeTint(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((channel) => typeof channel === "number");
}

/* @invariant
 * Measured on Chrome for Testing 156.0.8078.4 (headless, Extensions.loadUnpacked,
 * 2026-11-18) and read in chrome/common/extensions/manifest_handlers/theme_handler.cc:
 * a theme.colors value that is not a list of three integers, or of three integers
 * and a number, and a theme.tints value that is not a list of three numbers, each
 * fail the whole manifest, so the theme is not installed at all. Firefox reads a
 * color as an array or as any CSS color string (MDN, manifest.json/theme).
 */
export function chromeThemeRefusals(theme: unknown): { colors: ChromeThemeRefusal[]; tints: ChromeThemeRefusal[] } {
  const block = theme && typeof theme === "object" ? (theme as Record<string, unknown>) : {};
  const entries = (section: unknown): Array<[string, unknown]> =>
    section && typeof section === "object" && !Array.isArray(section) ? Object.entries(section as Record<string, unknown>) : [];

  return {
    colors: entries(block.colors)
      .filter(([, value]) => !isChromeColor(value))
      .map(([key, value]) => ({ slot: `colors.${key}`, write: arrayForCssColor(value) })),
    tints: entries(block.tints)
      .filter(([, value]) => !isChromeTint(value))
      .map(([key]) => ({ slot: `tints.${key}`, write: null })),
  };
}

function listed(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
}

export function chromeThemeRefusalLines(theme: unknown): string[] {
  const { colors, tints } = chromeThemeRefusals(theme);
  const lines: string[] = [];

  if (colors.length) {
    const fixes = colors.map(({ slot, write }) => `theme.${slot} as ${write ?? "its [r, g, b] values"}`);

    lines.push(
      `Chromium refuses to load this theme ("${CHROME_SAYS_BAD_COLORS}"): it reads a theme.colors value only as an array of integers, [r, g, b] or [r, g, b, alpha], so write ${listed(fixes)}; Firefox reads the same arrays, so one manifest serves both, and CSS color strings kept for Firefox go under "firefox:theme" with the arrays under "chromium:theme"`,
    );
  }

  if (tints.length) {
    lines.push(
      `Chromium refuses to load this theme ("${CHROME_SAYS_BAD_TINTS}"): it reads a theme.tints value only as an array of three numbers, [hue, saturation, lightness], so write ${listed(tints.map(({ slot }) => `theme.${slot}`))} that way`,
    );
  }

  return lines;
}
