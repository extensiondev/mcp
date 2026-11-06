// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const LAUNCHABLE_BROWSERS = [
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "yandex",
  "firefox",
  "waterfox",
  "librewolf",
  "zen",
  "floorp",
  "safari",
  "chromium-based",
  "gecko-based",
  "firefox-based",
  "webkit-based",
] as const;

export const REAL_BROWSERS = [
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "yandex",
  "firefox",
  "waterfox",
  "librewolf",
  "zen",
  "floorp",
  "safari",
] as const;

export const MANAGED_BROWSERS = ["chrome", "chromium", "edge", "firefox"] as const;

export const PROJECT_PATH = {
  type: "string",
  description: "Extension project root",
} as const;

export const SESSION_PROJECT_PATH = {
  type: "string",
  description:
    "Project root of a running session: extension_dev, extension_start, or `npx extension dev|start` by hand",
} as const;

export const SESSION_BROWSER = {
  type: "string",
  description: "Session browser; required when several run.",
} as const;

export const CALL_TIMEOUT = {
  type: "number",
  description: "Timeout ms (default 30000; Firefox 10000; debug port 15000).",
} as const;

export const API_BASE = {
  type: "string",
  description:
    "Platform URL; default EXTENSION_DEV_API_URL.",
} as const;

export const LAUNCH_BROWSER = {
  type: "string",
  enum: LAUNCHABLE_BROWSERS,
  default: "chrome",
  description: "Target browser; *-based pairs with chromiumBinary or geckoBinary.",
} as const;
