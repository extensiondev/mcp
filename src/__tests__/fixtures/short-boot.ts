// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type * as BootVerdictModule from "../../lib/boot-verdict";
import type * as TimersModule from "node:timers/promises";

export const SHORT_BOOT_MS = 200;
export const SHORT_SLEEP_MS = 100;

export function shortBootWindow(actual: typeof BootVerdictModule, windowMs = SHORT_BOOT_MS): typeof BootVerdictModule {
  return {
    ...actual,
    pollBootVerdict: (projectPath, browser, options) =>
      actual.pollBootVerdict(projectPath, browser, { ...options, budgetMs: Math.min(options.budgetMs, windowMs) }),
  };
}

export function shortSleeps(actual: typeof TimersModule): typeof TimersModule {
  return {
    ...actual,
    setTimeout: ((ms?: number, value?: unknown, options?: unknown) =>
      actual.setTimeout(Math.min(ms ?? 0, SHORT_SLEEP_MS), value, options as never)) as typeof actual.setTimeout,
  };
}
