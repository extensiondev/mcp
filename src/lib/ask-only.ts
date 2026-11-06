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

const LISTING_IMAGE_STAGE = /^\/api\/projects\/[^/]+\/stores\/[^/]+\/listing\/images$/;

const stagesAListingImage = (method: string, path: string): boolean => method === "PUT" && LISTING_IMAGE_STAGE.test(path);

export function askOnlyBlocks(method: string, body: unknown, path = ""): boolean {
  if (!askingOnly() || carriesApproval(body)) return askingOnly();

  return method !== "POST" && !stagesAListingImage(method, path);
}
