// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { inconclusiveCheck } from "./verdict";

import type { CheckResult } from "./verdict";

export function notReadyCheck(
  id: string,
  subject: string | null,
  detail: string,
  settledBy: string,
  evidence?: Record<string, unknown>,
): CheckResult {
  return { ...inconclusiveCheck(id, subject, detail, settledBy, evidence), reason: "not-ready" };
}

export function pageNotOpenSettledBy(url: string): string {
  return `The page this check reads is not open: open it with extension_open (url: '${url}'), wait for it to load, then assert again.`;
}
