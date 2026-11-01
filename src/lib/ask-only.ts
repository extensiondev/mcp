// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

export const ASK_ONLY_CODE = "ASK_ONLY";

const asking = new AsyncLocalStorage<true>();

export function askingOnly(): boolean {
  return asking.getStore() === true;
}

export function runAskingOnly<T>(run: () => Promise<T>): Promise<T> {
  return asking.run(true, run);
}

const carriesApproval = (body: unknown): boolean =>
  Boolean(body) && typeof body === "object" && typeof (body as Record<string, unknown>).approvalId === "string" && Boolean(((body as Record<string, unknown>).approvalId as string).trim());

export function askOnlyBlocks(method: string, body: unknown): boolean {
  return askingOnly() && (method !== "POST" || carriesApproval(body));
}
