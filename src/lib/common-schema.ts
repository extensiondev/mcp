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
  "safari",
] as const;

export const MANAGED_BROWSERS = ["chrome", "chromium", "edge", "firefox"] as const;

export const PROJECT_PATH = {
  type: "string",
  description: "Extension project root",
} as const;

export const SESSION_PROJECT_PATH = {
  type: "string",
  description: "Extension project root (needs a live dev session)",
} as const;

export const SESSION_BROWSER = {
  type: "string",
  description: "Session browser; defaults to this project's live session",
} as const;

export const CALL_TIMEOUT = {
  type: "number",
  description: "Command timeout in ms (default 5000)",
} as const;

export const API_BASE = {
  type: "string",
  description:
    "Platform base URL (default EXTENSION_DEV_API_URL, else https://www.extension.dev)",
} as const;

export const LAUNCH_BROWSER = {
  type: "string",
  enum: LAUNCHABLE_BROWSERS,
  default: "chrome",
} as const;
