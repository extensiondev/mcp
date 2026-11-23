// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { WAIT_SECONDS_DEFAULT, WAIT_SECONDS_MAX } from "./outcome-clock";

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
  description: "Session browser; required if several run.",
} as const;

export const CALL_TIMEOUT = {
  type: "number",
  description: "Timeout ms (default 30000; Firefox 10000; debug port 15000).",
} as const;

export const HOSTED_ACT_WAIT_SECONDS = 45;

export function waitSecondsInput(waitsFor: string, omitted: string): { type: "number"; description: string } {
  return {
    type: "number",
    description: `${waitsFor}, 0 to ${WAIT_SECONDS_MAX} (omitted: ${omitted}); the hosted lane waits at most ${HOSTED_ACT_WAIT_SECONDS} and names a cut in warnings.`,
  };
}

const ACT_WAITS_FOR = "Seconds to wait for the result (with approvalId, the approval)";
const ACT_OMITTED = `${WAIT_SECONDS_DEFAULT}, no wait for the approval`;

export const ACT_WAIT_SECONDS = waitSecondsInput(ACT_WAITS_FOR, ACT_OMITTED);

export const SUBMIT_WAIT_SECONDS = waitSecondsInput(ACT_WAITS_FOR, `${ACT_OMITTED}; status, connect, first-submission: 0`);

export const API_BASE = {
  type: "string",
  description:
    "Platform URL; default from env.",
} as const;

export const LAUNCH_BROWSER = {
  type: "string",
  enum: LAUNCHABLE_BROWSERS,
  default: "chrome",
  description: "Target browser; *-based pairs with chromiumBinary or geckoBinary.",
} as const;
