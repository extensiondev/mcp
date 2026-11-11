// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { repeatChangesNothing } from "./tool-annotations";

export type RetryVerdict = "safe" | "after-read" | "no";

export const RETRY_VERDICTS: RetryVerdict[] = ["safe", "after-read", "no"];

const TRANSIENT_CODES = new Set<string>([
  "E_BRIDGE",
  "E_BUILD_TIMEOUT",
  "E_CDP",
  "E_CONTROL_CHANNEL",
  "E_CONTROL_ENVELOPE",
  "E_CREATE_STUCK",
  "E_EXTENSION_RELOADING",
  "E_FIRST_COMPILE",
  "E_INTERNAL",
  "E_NETWORK",
  "E_PLATFORM",
  "E_PREVIEW_HOST_UNREACHABLE",
  "E_RDP",
  "E_SAFARI_APP_BUILDING",
  "E_SAFARI_CONTEXT_UNREACHABLE",
  "E_TEMPLATE_FETCH",
  "E_WAIT_TIMEOUT",
]);

function approvalRefunded(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { approvalRefunded?: unknown }).approvalRefunded === true;
}

export function retryVerdict(error: { code?: unknown; retry?: unknown; platformCode?: unknown }, command: string, value?: unknown): RetryVerdict {
  if (RETRY_VERDICTS.includes(error.retry as RetryVerdict)) return error.retry as RetryVerdict;
  if (approvalRefunded(value)) return "safe";
  if (!TRANSIENT_CODES.has(String(error.code))) return "no";
  if (error.code === "E_PLATFORM" && typeof error.platformCode === "string") return "no";

  return repeatChangesNothing(command) ? "safe" : "after-read";
}

export function withRetry<T extends { code?: unknown; retry?: unknown; platformCode?: unknown }>(error: T, command: string, value?: unknown): T & { retry: RetryVerdict } {
  return { ...error, retry: retryVerdict(error, command, value) };
}
