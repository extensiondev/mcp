// VENDORED FILE - DO NOT HAND-EDIT.
//
// Synced verbatim from packages/emulator/src/browser-ui/lib/chrome-theme-reference.ts
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

export type ChromeThemeColorKeyStatus =
  | "rendered"
  | "incognito-dead"
  | "dropped"
  | "alias";

export interface ChromeThemeColorKeyInfo {
  status: ChromeThemeColorKeyStatus;
  aliasFor?: string;
  note?: string;
}

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
      note: "Seeds bookmark_text and tab_text when those are unset (custom_theme_supplier.cc:127-132 at 157.0.8103.0).",
    },
    toolbar_button_icon: { status: "rendered" },
    tab_text: {
      status: "rendered",
      note: "Active tab foreground, both window states (custom_theme_supplier.cc:133-138 at 157.0.8103.0 copies it to the inactive-frame slot).",
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
      note: "Opaquified over the results background at pack build (custom_theme_supplier.cc:139-153 at 157.0.8103.0).",
    },
    omnibox_background: {
      status: "rendered",
      note: "Maps to the suggestions dropdown (kColorOmniboxResultsBackground, custom_theme_supplier.cc:182 at 157.0.8103.0). The omnibox FIELD is always derived from toolbar.",
    },
    button_background: {
      status: "rendered",
      note: "Windows caption-button background only (kColorCaptionButtonBackground, custom_theme_supplier.cc:172 at 157.0.8103.0). Not toolbar buttons.",
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
      note: "Legacy fallback only when ntp_header is absent (browser_theme_pack.cc:1243-1250 at 157.0.8103.0).",
    },
    tab_text_inactive: { status: "dropped" },
    tab_text_incognito: { status: "dropped" },
    ntp_link_underline: { status: "dropped" },
    ntp_section_text: { status: "dropped" },
    tab_background_separator: { status: "dropped" },
  };

export const CHROME_THEME_TINT_KEYS = [
  "buttons",
  "frame",
  "frame_inactive",
  "background_tab",
  "frame_incognito",
  "frame_incognito_inactive",
] as const;

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

export const CHROME_THEME_PROPERTY_KEYS = [
  "ntp_background_alignment",
  "ntp_background_repeat",
  "ntp_logo_alternate",
] as const;

export const CHROME_THEME_DEFAULTS = {
  frame: "#dee1e6",
  toolbar: "#ffffff",
  toolbarText: "#3c4043",
  toolbarButtonIconBase: "#5f6368",
  ntpBackground: "#ffffff",
  ntpText: "#000000",
  ntpLink: "#063774",
  ntpHeader: "#969696",
  omniboxTextOpaquifyBase: "#f1f3f4",
} as const;

export const CHROME_THEME_DEFAULT_TINTS = {
  frame: { h: -1, s: -1, l: -1 },
  frame_inactive: { h: -1, s: -1, l: 0.642 },
  buttons: { h: -1, s: -1, l: -1 },
  background_tab: { h: -1, s: -1, l: -1 },
} as const;

export const CHROME_TAB_FOREGROUND_CONTRAST = {
  activeFrameActive: 10.46,
  activeFrameInactive: 5.0,
  inactiveFrameActive: 7.98,
  inactiveFrameInactive: 4.5,
} as const;

export const CHROME_TAB_INACTIVE_WINDOW_FG_BLEND = 0.75;

export const CHROME_TAB_SURFACE_BLENDS = {
  inactiveHover: 0.4,
  selected: 0.75,
  selectedHover: 0.85,
} as const;

export const CHROME_OMNIBOX_TOOLBAR_MIN_CONTRAST = 1.3;

export const CHROME_CAPTION_BUTTON_OPAQUE_ALPHA = 0xcc;

export const CHROME_FRAME_HEIGHT_ABOVE_TABS = 16;

export const CHROME_THEME_IMAGE_CROP_HEIGHTS = {
  frame: 60,
  toolbar: 200,
  buttonBackground: 60,
  windowControlBackground: 50,
} as const;

export const CHROME_THEME_IMAGE_RULES = {
  themeAnchorYAboveBrowserView: 16,
  frame: { repeatX: true, repeatY: false, macTopCropPx: 16 },
  frameOverlay: { repeatX: false, repeatY: false },
  toolbar: { themeAligned: true },
  tabBackground: {
    themeAligned: true,
    generatedFromFrameShiftPx: 16,
    generatedTint: "background_tab",
    generatedHeightClampPx: 41,
  },
  ntpBackground: {
    cssSize: "auto",
    repeatCss: {
      "no-repeat": { x: "no-repeat", y: "no-repeat" },
      "repeat-x": { x: "repeat", y: "no-repeat" },
      "repeat-y": { x: "no-repeat", y: "repeat" },
      repeat: { x: "repeat", y: "repeat" },
    },
  },
  ntpAttribution: { corner: "bottom-left", offsetPx: 16 },
  buttonBackground: { macPaintSite: false },
} as const;
