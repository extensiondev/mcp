// VENDORED FILE - DO NOT HAND-EDIT.
//
// Synced verbatim from packages/extensiondev-emulator/src/browser-ui/lib/chrome-theme-resolve.ts
// by packages/public-extensiondev-mcp/scripts/sync-chrome-theme-vendor.mjs.
//
// The published @extension.dev/mcp must not take a workspace dependency on
// @extension.dev/emulator (the carrier ships decoupled), so this pure resolver
// is copied in. Edit the emulator source, then re-run the sync script.

/**
 * resolveChromeTheme: given a theme manifest (the exact JSON a user would
 * install), produce every color current stable Chrome would paint, by
 * replaying the pipeline transcribed in chrome-theme-reference.ts:
 *
 *   1. pack build: BrowserThemePack::AdjustThemePack color steps
 *      (GenerateFrameColorsFromTints, SetFrameAndToolbarRelatedColors,
 *      GenerateWindowControlButtonColor, GenerateMissingNtpColors)
 *   2. render: the classic color mixers that remain active for themed
 *      clients (chrome_color_mixer, tab_strip_color_mixer,
 *      omnibox_color_mixer, plus the pack's own mixer which runs last).
 *
 * Image-DERIVED colors (k-means of frame/toolbar/tab images,
 * browser_theme_pack.cc ComputeImageColor) are not modeled yet; themes that
 * rely on images without colors resolve to the color defaults. That gap is
 * Phase 3 of THEME_REALISM_PLAN.md and is reported via `caveats`.
 */

import {
  type HslTint,
  type RgbaColor,
  HSL_NO_TINT,
  alphaBlend,
  blendForMinContrast,
  contrastRatio,
  getColorWithMaxContrast,
  getEndpointColorWithMinContrast,
  getResultingPaintColor,
  hslShift,
  isColorGrayscale,
  makeHslShiftValid,
  parseHexColor,
  relativeLuminance,
  rgba,
  toHexColor,
} from "./chrome-theme-color-math";
import {
  CHROME_CAPTION_BUTTON_OPAQUE_ALPHA,
  CHROME_OMNIBOX_TOOLBAR_MIN_CONTRAST,
  CHROME_TAB_FOREGROUND_CONTRAST,
  CHROME_TAB_INACTIVE_WINDOW_FG_BLEND,
  CHROME_TAB_SURFACE_BLENDS,
  CHROME_THEME_COLOR_KEYS,
  CHROME_THEME_DEFAULTS,
  CHROME_THEME_DEFAULT_TINTS,
} from "./chrome-theme-reference";

export interface ChromeThemeManifestTheme {
  colors?: Record<string, number[]>;
  tints?: Record<string, number[]>;
  properties?: Record<string, unknown>;
  images?: Record<string, string>;
}

/** All hex unless noted. Slot names follow Chromium's color ids. */
export interface ResolvedChromeTheme {
  frameActive: string;
  frameInactive: string;
  toolbar: string;
  toolbarText: string;
  toolbarButtonIcon: string;
  toolbarTopSeparator: string;
  tabBackgroundActiveFrameActive: string;
  tabBackgroundActiveFrameInactive: string;
  tabBackgroundInactiveFrameActive: string;
  tabBackgroundInactiveFrameInactive: string;
  tabForegroundActiveFrameActive: string;
  tabForegroundActiveFrameInactive: string;
  tabForegroundInactiveFrameActive: string;
  tabForegroundInactiveFrameInactive: string;
  tabBackgroundInactiveHoverFrameActive: string;
  tabBackgroundSelectedFrameActive: string;
  bookmarkText: string;
  ntpBackground: string;
  ntpText: string;
  ntpLink: string;
  ntpHeader: string;
  /** rgba() string: header at 0x50 alpha (browser_theme_pack.cc:2010). */
  ntpSectionBorder: string;
  ntpLogoAlternate: 0 | 1;
  omniboxFieldBackground: string;
  omniboxFieldText: string;
  omniboxResultsBackground: string;
  windowControlButtonBackgroundActive: string;
  windowControlButtonBackgroundInactive: string;
  newTabButtonForeground: string;
  newTabButtonBackground: string;
  properties: {
    ntpBackgroundAlignment: string;
    ntpBackgroundRepeat: "no-repeat" | "repeat" | "repeat-x" | "repeat-y";
  };
  /** Honored manifest keys that were dropped/ignored, with reasons. */
  ignoredKeys: { key: string; reason: string }[];
  /** Fidelity caveats (e.g. image-derived colors not modeled). */
  caveats: string[];
}

/** browser_theme_pack.cc:1405 ReadColorsFromJSON, honored keys only. */
function parseManifestColors(
  colors: Record<string, number[]> | undefined,
  ignoredKeys: ResolvedChromeTheme["ignoredKeys"],
): Map<string, RgbaColor> {
  const out = new Map<string, RgbaColor>();
  if (!colors) return out;
  for (const [key, value] of Object.entries(colors)) {
    if (!Array.isArray(value) || value.length < 3 || value.length > 4) {
      ignoredKeys.push({ key, reason: "malformed color value" });
      continue;
    }
    const [r, g, b, alphaRaw] = value;
    if (
      [r, g, b].some(
        (channel) =>
          typeof channel !== "number" ||
          !Number.isInteger(channel) ||
          channel < 0 ||
          channel > 255,
      )
    ) {
      ignoredKeys.push({ key, reason: "channel out of range" });
      continue;
    }
    let a = 255;
    if (value.length === 4) {
      if (typeof alphaRaw !== "number" || alphaRaw < 0 || alphaRaw > 1) {
        ignoredKeys.push({ key, reason: "alpha out of range" });
        continue;
      }
      a = Number.isInteger(alphaRaw)
        ? alphaRaw
          ? 255
          : 0
        : Math.round(alphaRaw * 255);
    }
    const color = rgba(r as number, g as number, b as number, a);

    const info = CHROME_THEME_COLOR_KEYS[key];
    if (!info) {
      ignoredKeys.push({ key, reason: "unknown key (dropped by Chrome)" });
      continue;
    }
    if (info.status === "dropped") {
      ignoredKeys.push({
        key,
        reason: "not parsed by current Chrome (kOverwritableColorTable)",
      });
      continue;
    }
    if (info.status === "incognito-dead") {
      ignoredKeys.push({
        key,
        reason:
          "incognito windows never render extension themes (theme_service.cc:741)",
      });
      continue;
    }
    if (info.status === "alias" && info.aliasFor) {
      if (!out.has(info.aliasFor) && !(colors[info.aliasFor] != null)) {
        out.set(info.aliasFor, color);
      } else {
        ignoredKeys.push({ key, reason: `superseded by ${info.aliasFor}` });
      }
      continue;
    }
    out.set(key, color);
  }
  return out;
}

/** browser_theme_pack.cc:1340 SetTintsFromJSON + MakeHSLShiftValid. */
function parseManifestTints(
  tints: Record<string, number[]> | undefined,
): Map<string, HslTint> {
  const out = new Map<string, HslTint>();
  if (!tints) return out;
  for (const [key, value] of Object.entries(tints)) {
    if (!Array.isArray(value) || value.length !== 3) continue;
    const [h, s, l] = value;
    if ([h, s, l].some((channel) => typeof channel !== "number")) continue;
    out.set(
      key,
      makeHslShiftValid({ h: h as number, s: s as number, l: l as number }),
    );
  }
  return out;
}

/** chrome_color_provider_utils.cc:52 GetToolbarTopSeparatorColor. */
function toolbarTopSeparatorColor(
  toolbar: RgbaColor,
  frame: RgbaColor,
): RgbaColor {
  const kContrastRatio = 2.0;
  const generate = (): RgbaColor => {
    let separator = rgba(255, 255, 255);
    if (relativeLuminance(toolbar) >= relativeLuminance(frame)) {
      separator = getColorWithMaxContrast(separator);
    }
    const first = blendForMinContrast(frame, frame, separator, kContrastRatio);
    if (contrastRatio(first.color, frame) >= kContrastRatio) {
      return { ...separator, a: first.alpha };
    }
    separator = getColorWithMaxContrast(separator);
    const second = blendForMinContrast(
      frame,
      toolbar,
      separator,
      kContrastRatio,
    );
    return { ...separator, a: second.alpha };
  };
  return getResultingPaintColor(generate(), frame);
}

/** browser_theme_pack.cc:615 ChooseOmniboxBgBlendTarget. */
function chooseOmniboxBgBlendTarget(toolbar: RgbaColor): RgbaColor {
  const endpoint = getEndpointColorWithMinContrast(toolbar);
  return contrastRatio(toolbar, endpoint) >=
    CHROME_OMNIBOX_TOOLBAR_MIN_CONTRAST
    ? endpoint
    : getColorWithMaxContrast(endpoint);
}

/** theme_properties.cc:167 StringToTiling (case-insensitive, default no-repeat). */
function normalizeTiling(
  value: unknown,
): ResolvedChromeTheme["properties"]["ntpBackgroundRepeat"] {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "repeat-x" || raw === "repeat-y" || raw === "repeat") return raw;
  return "no-repeat";
}

/** theme_properties.cc:148 StringToAlignment + AlignmentToString round-trip. */
function normalizeAlignment(value: unknown): string {
  const components =
    typeof value === "string" ? value.toLowerCase().split(/\s+/) : [];
  let vertical = "center";
  let horizontal = "center";
  for (const component of components) {
    if (component === "top" || component === "bottom") vertical = component;
    if (component === "left" || component === "right") horizontal = component;
  }
  return `${horizontal} ${vertical}`;
}

export function resolveChromeTheme(
  theme: ChromeThemeManifestTheme,
): ResolvedChromeTheme {
  const ignoredKeys: ResolvedChromeTheme["ignoredKeys"] = [];
  const caveats: string[] = [];
  const colors = parseManifestColors(theme.colors, ignoredKeys);
  const tints = parseManifestTints(theme.tints);
  const images = theme.images ?? {};

  const tintOrDefault = (key: keyof typeof CHROME_THEME_DEFAULT_TINTS) =>
    tints.get(key) ?? CHROME_THEME_DEFAULT_TINTS[key];

  if (
    ["theme_frame", "theme_toolbar", "theme_tab_background"].some(
      (key) => images[key],
    )
  ) {
    caveats.push(
      "frame/toolbar/tab images present: Chrome derives missing surface colors from the image (k-means); this resolver uses color defaults instead",
    );
  }

  // GenerateFrameColorsFromTints (browser_theme_pack.cc:1787).
  const defaultFrame = parseHexColor(CHROME_THEME_DEFAULTS.frame);
  const frameActive =
    colors.get("frame") ?? hslShift(defaultFrame, tintOrDefault("frame"));
  const frameInactive =
    colors.get("frame_inactive") ??
    hslShift(frameActive, tintOrDefault("frame_inactive"));

  // SetFrameAndToolbarRelatedColors (browser_theme_pack.cc:1630).
  const toolbarSpecified = colors.has("toolbar");
  const toolbar =
    colors.get("toolbar") ?? parseHexColor(CHROME_THEME_DEFAULTS.toolbar);
  if (toolbarSpecified && !colors.has("toolbar_text")) {
    colors.set(
      "toolbar_text",
      blendForMinContrast(
        parseHexColor(CHROME_THEME_DEFAULTS.toolbarText),
        toolbar,
      ).color,
    );
  }
  const toolbarText =
    colors.get("toolbar_text") ??
    parseHexColor(CHROME_THEME_DEFAULTS.toolbarText);
  if (colors.has("toolbar_text")) {
    if (!colors.has("bookmark_text")) colors.set("bookmark_text", toolbarText);
    if (!colors.has("tab_text")) colors.set("tab_text", toolbarText);
  }
  // browser_theme_pack.cc:1668: the active-tab foreground always carries to
  // the inactive-window slot when present in the pack.
  const packTabFgActiveFrameInactive = colors.get("tab_text");

  const omniboxBackgroundSpecified = colors.has("omnibox_background");
  if (omniboxBackgroundSpecified) {
    colors.set(
      "omnibox_background",
      getResultingPaintColor(colors.get("omnibox_background")!, toolbar),
    );
  }
  if (colors.has("omnibox_text")) {
    colors.set(
      "omnibox_text",
      getResultingPaintColor(
        colors.get("omnibox_text")!,
        colors.get("omnibox_background") ??
          parseHexColor(CHROME_THEME_DEFAULTS.omniboxTextOpaquifyBase),
      ),
    );
  }

  // GenerateWindowControlButtonColor (browser_theme_pack.cc:1808).
  const captionButtonBase = colors.get("button_background") ?? rgba(0, 0, 0, 0);
  const captionAlpha =
    captionButtonBase.a === 255
      ? CHROME_CAPTION_BUTTON_OPAQUE_ALPHA
      : captionButtonBase.a;
  const windowControlActive = alphaBlend(
    captionButtonBase,
    frameActive,
    captionAlpha / 255,
  );
  const windowControlInactive = alphaBlend(
    captionButtonBase,
    frameInactive,
    captionAlpha / 255,
  );

  // GenerateMissingNtpColors (browser_theme_pack.cc:1961).
  const hasNtpImage = Boolean(images.theme_ntp_background);
  const ntpBackgroundSpecified = colors.has("ntp_background");
  if (ntpBackgroundSpecified) {
    colors.set(
      "ntp_background",
      getResultingPaintColor(
        colors.get("ntp_background")!,
        parseHexColor(CHROME_THEME_DEFAULTS.ntpBackground),
      ),
    );
  }
  const ntpBackground =
    colors.get("ntp_background") ??
    parseHexColor(CHROME_THEME_DEFAULTS.ntpBackground);
  if (!colors.has("ntp_text") && (hasNtpImage || ntpBackgroundSpecified)) {
    if (hasNtpImage) {
      caveats.push(
        "ntp_text derived from the NTP image's dominant color in Chrome; resolver derives from ntp_background instead",
      );
    }
    colors.set("ntp_text", getColorWithMaxContrast(ntpBackground));
  }
  const ntpText =
    colors.get("ntp_text") ?? parseHexColor(CHROME_THEME_DEFAULTS.ntpText);
  const logoAlternateRaw = theme.properties?.ntp_logo_alternate;
  const ntpLogoAlternate: 0 | 1 =
    typeof logoAlternateRaw === "number"
      ? logoAlternateRaw
        ? 1
        : 0
      : hasNtpImage ||
          (ntpBackgroundSpecified && !isColorGrayscale(ntpBackground))
        ? 1
        : 0;
  const ntpHeader =
    colors.get("ntp_header") ?? parseHexColor(CHROME_THEME_DEFAULTS.ntpHeader);

  // Pack mixer + omnibox mixer (browser_theme_pack.cc:1122,
  // omnibox_color_mixer.cc:279-306).
  const omniboxFieldBackground = blendForMinContrast(
    toolbar,
    toolbar,
    chooseOmniboxBgBlendTarget(toolbar),
    CHROME_OMNIBOX_TOOLBAR_MIN_CONTRAST,
  ).color;
  const omniboxFieldText =
    colors.get("omnibox_text") ?? getColorWithMaxContrast(omniboxFieldBackground);
  const omniboxResultsBackground =
    colors.get("omnibox_background") ?? getColorWithMaxContrast(omniboxFieldText);

  // tab_strip_color_mixer.cc.
  const tabBackgroundActiveFrameActive = toolbar;
  const tabBackgroundActiveFrameInactive = tabBackgroundActiveFrameActive;
  const backgroundTabTint = tints.get("background_tab") ?? HSL_NO_TINT;
  const tabBackgroundInactiveFrameActive =
    colors.get("background_tab") ?? hslShift(frameActive, backgroundTabTint);
  const tabBackgroundInactiveFrameInactive =
    colors.get("background_tab_inactive") ??
    hslShift(frameInactive, backgroundTabTint);

  const resolveTabForeground = (
    packColor: RgbaColor | undefined,
    base: RgbaColor,
    background: RgbaColor,
    contrast: number,
    inactiveWindow: boolean,
  ): RgbaColor => {
    if (packColor) return packColor;
    const blendedBase = inactiveWindow
      ? alphaBlend(base, background, CHROME_TAB_INACTIVE_WINDOW_FG_BLEND)
      : base;
    return blendForMinContrast(
      blendedBase,
      background,
      getColorWithMaxContrast(background),
      contrast,
    ).color;
  };

  const tabForegroundActiveFrameActive = resolveTabForeground(
    colors.get("tab_text"),
    toolbarText,
    tabBackgroundActiveFrameActive,
    CHROME_TAB_FOREGROUND_CONTRAST.activeFrameActive,
    false,
  );
  const tabForegroundActiveFrameInactive = resolveTabForeground(
    packTabFgActiveFrameInactive,
    tabForegroundActiveFrameActive,
    tabBackgroundActiveFrameInactive,
    CHROME_TAB_FOREGROUND_CONTRAST.activeFrameInactive,
    true,
  );
  const tabForegroundInactiveFrameActive = resolveTabForeground(
    colors.get("tab_background_text"),
    toolbarText,
    tabBackgroundInactiveFrameActive,
    CHROME_TAB_FOREGROUND_CONTRAST.inactiveFrameActive,
    false,
  );
  const tabForegroundInactiveFrameInactive = resolveTabForeground(
    colors.get("tab_background_text_inactive"),
    colors.get("tab_background_text") ?? tabForegroundInactiveFrameActive,
    tabBackgroundInactiveFrameInactive,
    CHROME_TAB_FOREGROUND_CONTRAST.inactiveFrameInactive,
    true,
  );

  const bookmarkText = colors.get("bookmark_text") ?? toolbarText;
  const toolbarButtonIcon =
    colors.get("toolbar_button_icon") ??
    hslShift(
      parseHexColor(CHROME_THEME_DEFAULTS.toolbarButtonIconBase),
      tints.get("buttons") ?? CHROME_THEME_DEFAULT_TINTS.buttons,
    );

  const ntpSectionBorder = `rgba(${ntpHeader.r}, ${ntpHeader.g}, ${ntpHeader.b}, ${(
    0x50 / 255
  ).toFixed(3)})`;

  return {
    frameActive: toHexColor(frameActive),
    frameInactive: toHexColor(frameInactive),
    toolbar: toHexColor(toolbar),
    toolbarText: toHexColor(toolbarText),
    toolbarButtonIcon: toHexColor(toolbarButtonIcon),
    toolbarTopSeparator: toHexColor(
      toolbarTopSeparatorColor(toolbar, frameActive),
    ),
    tabBackgroundActiveFrameActive: toHexColor(tabBackgroundActiveFrameActive),
    tabBackgroundActiveFrameInactive: toHexColor(
      tabBackgroundActiveFrameInactive,
    ),
    tabBackgroundInactiveFrameActive: toHexColor(
      tabBackgroundInactiveFrameActive,
    ),
    tabBackgroundInactiveFrameInactive: toHexColor(
      tabBackgroundInactiveFrameInactive,
    ),
    tabForegroundActiveFrameActive: toHexColor(tabForegroundActiveFrameActive),
    tabForegroundActiveFrameInactive: toHexColor(
      tabForegroundActiveFrameInactive,
    ),
    tabForegroundInactiveFrameActive: toHexColor(
      tabForegroundInactiveFrameActive,
    ),
    tabForegroundInactiveFrameInactive: toHexColor(
      tabForegroundInactiveFrameInactive,
    ),
    tabBackgroundInactiveHoverFrameActive: toHexColor(
      alphaBlend(
        tabBackgroundActiveFrameActive,
        tabBackgroundInactiveFrameActive,
        CHROME_TAB_SURFACE_BLENDS.inactiveHover,
      ),
    ),
    tabBackgroundSelectedFrameActive: toHexColor(
      alphaBlend(
        tabBackgroundActiveFrameActive,
        tabBackgroundInactiveFrameActive,
        CHROME_TAB_SURFACE_BLENDS.selected,
      ),
    ),
    bookmarkText: toHexColor(bookmarkText),
    ntpBackground: toHexColor(ntpBackground),
    ntpText: toHexColor(ntpText),
    ntpLink: toHexColor(
      colors.get("ntp_link") ?? parseHexColor(CHROME_THEME_DEFAULTS.ntpLink),
    ),
    ntpHeader: toHexColor(ntpHeader),
    ntpSectionBorder,
    ntpLogoAlternate,
    omniboxFieldBackground: toHexColor(omniboxFieldBackground),
    omniboxFieldText: toHexColor(omniboxFieldText),
    omniboxResultsBackground: toHexColor(omniboxResultsBackground),
    windowControlButtonBackgroundActive: toHexColor(windowControlActive),
    windowControlButtonBackgroundInactive: toHexColor(windowControlInactive),
    newTabButtonForeground: toHexColor(tabForegroundInactiveFrameActive),
    newTabButtonBackground: toHexColor(tabBackgroundInactiveFrameActive),
    properties: {
      ntpBackgroundAlignment: normalizeAlignment(
        theme.properties?.ntp_background_alignment,
      ),
      ntpBackgroundRepeat: normalizeTiling(
        theme.properties?.ntp_background_repeat,
      ),
    },
    ignoredKeys,
    caveats,
  };
}
