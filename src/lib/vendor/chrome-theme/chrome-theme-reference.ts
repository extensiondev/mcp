// VENDORED FILE - DO NOT HAND-EDIT.
//
// Synced verbatim from packages/extensiondev-emulator/src/browser-ui/lib/chrome-theme-reference.ts
// by packages/public-extensiondev-mcp/scripts/sync-chrome-theme-vendor.mjs.
//
// The published @extension.dev/mcp must not take a workspace dependency on
// @extension.dev/emulator (the carrier ships decoupled), so this pure resolver
// is copied in. Edit the emulator source, then re-run the sync script.

/**
 * Ground truth for how CURRENT stable Chrome renders an installed extension
 * theme, transcribed from the Chromium source tree (refs/heads/main, cached
 * under parity/chromium-src-cache, fetched 2026-07-04).
 *
 * Three load-bearing facts anchor everything here:
 *
 * 1. browser_theme_pack.cc:237 kOverwritableColorTable is the complete list
 *    of manifest color keys modern Chrome parses. Anything else in
 *    theme.colors is silently dropped at parse time.
 * 2. theme_service.cc:741 GetColorProviderKey sets custom_theme = nullptr
 *    for incognito profiles: incognito windows NEVER render an extension
 *    theme. Every *_incognito manifest key parses into the pack but is
 *    unreachable at render time.
 * 3. chrome_color_provider_utils.cc ShouldApplyChromeMaterialOverrides
 *    returns !key.custom_theme: the GM3/material mixer layer is skipped
 *    entirely for themed clients, so the classic mixers + the
 *    theme_properties.cc defaults below are the exact render pipeline.
 */

/** How a manifest theme.colors key behaves in current stable Chrome. */
export type ChromeThemeColorKeyStatus =
  /** Parsed and rendered (possibly only on specific surfaces). */
  | "rendered"
  /** Parsed but never rendered (incognito windows drop themes). */
  | "incognito-dead"
  /** Not in kOverwritableColorTable: silently dropped at parse. */
  | "dropped"
  /** Legacy alias parsed into another key. */
  | "alias";

export interface ChromeThemeColorKeyInfo {
  status: ChromeThemeColorKeyStatus;
  /** For "alias": the key that actually receives the value. */
  aliasFor?: string;
  note?: string;
}

/**
 * Per-key status table for manifest theme.colors, derived from
 * kOverwritableColorTable (browser_theme_pack.cc:237-271) plus the
 * incognito suppression (theme_service.cc:741) and the ntp_section legacy
 * fallback (browser_theme_pack.cc:1451-1457).
 *
 * Keys of historical themes that do NOT appear in the table (tab_text_inactive,
 * tab_text_incognito, ntp_link_underline, ntp_section_text,
 * tab_background_separator, ...) are "dropped": ReadColorsFromJSON only
 * accepts keys it can map (browser_theme_pack.cc:1459-1463).
 */
export const CHROME_THEME_COLOR_KEYS: Record<string, ChromeThemeColorKeyInfo> =
  {
    frame: { status: "rendered" },
    frame_inactive: { status: "rendered" },
    toolbar: {
      status: "rendered",
      note: "Also the active tab surface: kColorTabBackgroundActiveFrameActive = kColorToolbar (tab_strip_color_mixer.cc:51).",
    },
    toolbar_text: {
      status: "rendered",
      note: "Seeds bookmark_text and tab_text when those are unset (browser_theme_pack.cc:1662-1666).",
    },
    toolbar_button_icon: { status: "rendered" },
    tab_text: {
      status: "rendered",
      note: "Active tab foreground, both window states (browser_theme_pack.cc:1668-1672 copies it to the inactive-frame slot).",
    },
    tab_background_text: { status: "rendered" },
    tab_background_text_inactive: { status: "rendered" },
    background_tab: {
      status: "rendered",
      note: "COLOR key (not the tint): inactive tab surface, active window.",
    },
    background_tab_inactive: { status: "rendered" },
    bookmark_text: { status: "rendered" },
    ntp_background: { status: "rendered" },
    ntp_text: { status: "rendered" },
    ntp_link: { status: "rendered" },
    ntp_header: { status: "rendered" },
    omnibox_text: {
      status: "rendered",
      note: "Opaquified over the results background at pack build (browser_theme_pack.cc:1682-1687).",
    },
    omnibox_background: {
      status: "rendered",
      note: "Maps to the suggestions dropdown (kColorOmniboxResultsBackground, browser_theme_pack.cc:1142). The omnibox FIELD is always derived from toolbar.",
    },
    button_background: {
      status: "rendered",
      note: "Windows caption-button background only (kColorCaptionButtonBackground, browser_theme_pack.cc:1132). Not toolbar buttons.",
    },
    frame_incognito: { status: "incognito-dead" },
    frame_incognito_inactive: { status: "incognito-dead" },
    background_tab_incognito: { status: "incognito-dead" },
    background_tab_incognito_inactive: { status: "incognito-dead" },
    tab_background_text_incognito: { status: "incognito-dead" },
    tab_background_text_incognito_inactive: { status: "incognito-dead" },
    ntp_section: {
      status: "alias",
      aliasFor: "ntp_header",
      note: "Legacy fallback only when ntp_header is absent (browser_theme_pack.cc:1451-1457).",
    },
    tab_text_inactive: { status: "dropped" },
    tab_text_incognito: { status: "dropped" },
    ntp_link_underline: { status: "dropped" },
    ntp_section_text: { status: "dropped" },
    tab_background_separator: { status: "dropped" },
  };

/** kTintTable (browser_theme_pack.cc:222-232). */
export const CHROME_THEME_TINT_KEYS = [
  "buttons",
  "frame",
  "frame_inactive",
  "background_tab",
  "frame_incognito",
  "frame_incognito_inactive",
] as const;

/** kPersistingImages manifest keys (browser_theme_pack.cc:141-168). */
export const CHROME_THEME_IMAGE_KEYS = [
  "theme_frame",
  "theme_frame_inactive",
  "theme_frame_incognito",
  "theme_frame_incognito_inactive",
  "theme_toolbar",
  "theme_tab_background",
  "theme_tab_background_inactive",
  "theme_tab_background_incognito",
  "theme_tab_background_incognito_inactive",
  "theme_ntp_background",
  "theme_frame_overlay",
  "theme_frame_overlay_inactive",
  "theme_button_background",
  "theme_ntp_attribution",
  "theme_window_control_background",
] as const;

/** kDisplayProperties (browser_theme_pack.cc:297-306). */
export const CHROME_THEME_PROPERTY_KEYS = [
  "ntp_background_alignment",
  "ntp_background_repeat",
  "ntp_logo_alternate",
] as const;

/**
 * theme_properties.cc GetLightModeColor defaults: the base colors the pack
 * derivations and the classic mixers fall back to for themed clients
 * (material overrides are off with a custom theme, so these ARE the
 * baseline).
 */
export const CHROME_THEME_DEFAULTS = {
  /** theme_properties.cc:39 COLOR_FRAME_ACTIVE. */
  frame: "#dee1e6",
  /** chrome_color_mixer.cc:741 kColorToolbar (light). */
  toolbar: "#ffffff",
  /** theme_properties.cc:54 / chrome_color_mixer.cc:799: kGoogleGrey800. */
  toolbarText: "#3c4043",
  /** chrome_color_mixer.cc:762: HSLShift(kGoogleGrey700, TINT_BUTTONS). */
  toolbarButtonIconBase: "#5f6368",
  /** theme_properties.cc:56 COLOR_NTP_BACKGROUND. */
  ntpBackground: "#ffffff",
  /** theme_properties.cc:58 COLOR_NTP_TEXT. */
  ntpText: "#000000",
  /** theme_properties.cc:60 COLOR_NTP_LINK. */
  ntpLink: "#063774",
  /** theme_properties.cc:62 COLOR_NTP_HEADER. */
  ntpHeader: "#969696",
  /** browser_theme_pack.cc:1680: omnibox text opaquify base, kGoogleGrey100. */
  omniboxTextOpaquifyBase: "#f1f3f4",
} as const;

/**
 * theme_properties.cc:218 GetDefaultTint (non-incognito, non-dark): the only
 * default tint that is not a no-op is TINT_FRAME_INACTIVE, so an unspecified
 * frame_inactive is a LIGHTENED frame, not a copy.
 */
export const CHROME_THEME_DEFAULT_TINTS = {
  frame: { h: -1, s: -1, l: -1 },
  /** theme_properties.cc:250: #DEE1E6 -> #E7EAED. */
  frame_inactive: { h: -1, s: -1, l: 0.642 },
  buttons: { h: -1, s: -1, l: -1 },
  background_tab: { h: -1, s: -1, l: -1 },
} as const;

/**
 * tab_strip_color_mixer.cc:79-84 kTabFgToContrastMap: contrast each tab
 * foreground is blended to reach against its background when the theme does
 * not set it explicitly.
 */
export const CHROME_TAB_FOREGROUND_CONTRAST = {
  activeFrameActive: 10.46,
  activeFrameInactive: 5.0,
  inactiveFrameActive: 7.98,
  inactiveFrameInactive: 4.5,
} as const;

/**
 * tab_strip_color_mixer.cc:106-111: inactive-window foregrounds start from
 * the active-window color blended 75% toward the background before the
 * contrast pass.
 */
export const CHROME_TAB_INACTIVE_WINDOW_FG_BLEND = 0.75;

/** tab_strip_color_mixer.cc:141-164 hover/selected surface blends. */
export const CHROME_TAB_SURFACE_BLENDS = {
  inactiveHover: 0.4,
  selected: 0.75,
  selectedHover: 0.85,
} as const;

/** browser_theme_pack.cc:613 kMinOmniboxToolbarContrast. */
export const CHROME_OMNIBOX_TOOLBAR_MIN_CONTRAST = 1.3;

/**
 * window_frame_util.cc:11: a fully opaque button_background is knocked down
 * to 0xCC before blending over the frame.
 */
export const CHROME_CAPTION_BUTTON_OPAQUE_ALPHA = 0xcc;

/** theme_properties.h:206 kFrameHeightAboveTabs: tab background image offset. */
export const CHROME_FRAME_HEIGHT_ABOVE_TABS = 16;

/**
 * browser_theme_pack.cc:332-348 GetImagesToCrop: max useful image heights.
 * kTallestTabHeight = 41, kTallestFrameHeight = 41 + 19 = 60.
 */
export const CHROME_THEME_IMAGE_CROP_HEIGHTS = {
  frame: 60,
  toolbar: 200,
  buttonBackground: 60,
  windowControlBackground: 50,
} as const;

/**
 * Image PAINT rules (THEME_REALISM_PLAN.md Phase 3), transcribed at
 * refs/tags/143.0.7499.4.
 *
 * One anchor governs every frame/toolbar/tab image: theme image (0,0) sits
 * at (browserViewLeft, browserViewTop - kFrameHeightAboveTabs) in window
 * coordinates. browser_view.cc:1711 GetThemeOffsetFromBrowserView returns
 * exactly that source offset, and every paint site routes through it:
 * top_container_background.cc:49-75 PaintThemeAlignedImage (toolbar,
 * bookmarks bar), tab_style_views.cc:989-998 (BOTH the active tab's toolbar
 * image and inactive tabs' tab_background image), and
 * browser_frame_view_mac.mm:633-647 PaintThemedFrame (frame). On macOS the
 * BrowserView starts at the window top, so the anchor is 16 DIPs ABOVE the
 * window: the top 16 rows of frame/toolbar images are never visible (they
 * exist for the Windows/Linux frame band above the tabs).
 *
 * Tiling everywhere is SkTileMode::kRepeat horizontally and kMirror
 * vertically (top_container_background.cc:72-74). CSS has no mirror tiling;
 * the mock approximates y with plain repeat, which only diverges when an
 * image is shorter than the painted band (the density guidance in the
 * themes app warns before that happens).
 */
export const CHROME_THEME_IMAGE_RULES = {
  /**
   * Vertical anchor shared by all frame/toolbar/tab images: image (0,0) is
   * kFrameHeightAboveTabs DIPs above the BrowserView top
   * (browser_view.cc:1711-1721).
   */
  themeAnchorYAboveBrowserView: 16,
  /**
   * theme_frame: tiled horizontally across the window at natural height,
   * frame color underneath (browser_frame_view_mac.mm:640-644). Painted for
   * the whole frame band; rows 0-15 are cut on macOS (anchor above window).
   */
  frame: { repeatX: true, repeatY: false, macTopCropPx: 16 },
  /**
   * theme_frame_overlay: drawn ONCE at the window top-left corner, natural
   * size, no tiling, over the frame image
   * (browser_frame_view_mac.mm:645-646).
   */
  frameOverlay: { repeatX: false, repeatY: false },
  /**
   * theme_toolbar: theme-aligned (shared anchor), so the toolbar band shows
   * image rows starting at (16 + surface offset below BrowserView top). The
   * ACTIVE TAB uses the same image and the same anchor
   * (tab_style_views.cc:605-607, 989-998): the active tab looks "cut from"
   * the toolbar, exactly like real Chrome.
   */
  toolbar: { themeAligned: true },
  /**
   * theme_tab_background paints INACTIVE tabs, theme-aligned. When absent
   * but theme_frame is present, the pack GENERATES it: frame color base +
   * frame image shifted UP by kFrameHeightAboveTabs + background_tab tint,
   * clamped to kTallestTabHeight = 41 (browser_theme_pack.cc:2036-2057).
   * Net effect: inactive tabs show the (tinted) frame pixels behind them.
   */
  tabBackground: {
    themeAligned: true,
    generatedFromFrameShiftPx: 16,
    generatedTint: "background_tab",
    generatedHeightClampPx: 41,
  },
  /**
   * theme_ntp_background CSS matrix (new_tab_page_handler.cc:252-288):
   * size "initial" (natural size, never cover), alignment bitmask maps to
   * position with LEFT winning over RIGHT and TOP over BOTTOM, center
   * default on each axis; tiling maps to per-axis repeat pairs. Alignment
   * strings parse as whitespace-separated case-insensitive tokens
   * (theme_properties.cc:148-164); tiling defaults to no-repeat
   * (theme_properties.cc:167-178).
   */
  ntpBackground: {
    cssSize: "auto",
    repeatCss: {
      "no-repeat": { x: "no-repeat", y: "no-repeat" },
      "repeat-x": { x: "repeat", y: "no-repeat" },
      "repeat-y": { x: "no-repeat", y: "repeat" },
      repeat: { x: "repeat", y: "repeat" },
    },
  },
  /**
   * theme_ntp_attribution: fixed to the BOTTOM-LEFT corner (inline-start in
   * RTL), 16px bottom and inline margins, natural image size, under a
   * localized "Theme created by" caption in the NTP secondary text color
   * (app.html:155-160, app.css:210-216). NOT bottom-right, NOT dimmed.
   */
  ntpAttribution: { corner: "bottom-left", offsetPx: 16 },
  /**
   * theme_button_background / theme_window_control_background: the only
   * paint site is the Windows/Linux opaque frame's caption buttons
   * (opaque_browser_frame_view.cc:824). No macOS paint site; a mac-styled
   * mock correctly renders nothing for them.
   */
  buttonBackground: { macPaintSite: false },
} as const;
