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
  description: "The extension's folder (manifest.json or package.json).",
} as const;

export const SESSION_PROJECT_PATH = {
  type: "string",
  description:
    "Project root of a running session: extension_dev, extension_start, or `npx extension dev|start` by hand",
} as const;

export const SESSION_BROWSER = {
  type: "string",
  description: "Running session's browser; needed when several run.",
} as const;

export const CALL_TIMEOUT = {
  type: "number",
  description: "Timeout ms (default 30000; Firefox 10000; debug port 15000).",
} as const;

export const HOSTED_ACT_WAIT_SECONDS = 45;

export function waitSecondsInput(waitsFor: string, omitted: string): { type: "number"; description: string } {
  return {
    type: "number",
    description: `${waitsFor}, 0 to ${WAIT_SECONDS_MAX} (omitted: ${omitted}); the hosted server waits at most ${HOSTED_ACT_WAIT_SECONDS} and says so in warnings.`,
  };
}

const ACT_WAITS_FOR = "Seconds to wait for the result (with approvalId, the approval)";
const ACT_OMITTED = `${WAIT_SECONDS_DEFAULT}, no wait for the approval`;

export const ACT_WAIT_SECONDS = waitSecondsInput(ACT_WAITS_FOR, ACT_OMITTED);

export const SUBMIT_WAIT_SECONDS = waitSecondsInput(ACT_WAITS_FOR, `${ACT_OMITTED}; status, connect, first-submission: 0; a guided connect: ${WAIT_SECONDS_DEFAULT}`);

export const API_BASE = {
  type: "string",
  description:
    "Base URL; omitted: EXTENSION_DEV_API_URL, else extension.dev.",
} as const;

export const LAUNCH_BROWSER = {
  type: "string",
  enum: LAUNCHABLE_BROWSERS,
  default: "chrome",
  description: "Target browser; *-based pairs with chromiumBinary or geckoBinary.",
} as const;
