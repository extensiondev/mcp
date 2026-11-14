// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openProjectApi, projectApiGet, type ProjectApi } from "./project-api";
import { isRow, text } from "./row";

export type SafariReleaseIntent = "manual" | "after-approval";

export type SafariReleaseIntentRead = { intent: SafariReleaseIntent; source: "store-md" | "default" };

const MANUAL_INTENT = /^(manual|manually|manual release|hold|held)$/;

const AFTER_APPROVAL_INTENT = /^(after approval|on approval|automatic|automatically|auto|at once|immediately|release automatically( after approval)?)$/;

export const SAFARI_RELEASE_ON_SALE = /\bon sale\b/;

export function normalizeSafariReleaseIntent(value: unknown): SafariReleaseIntent | null {
  const words = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "");

  if (MANUAL_INTENT.test(words)) return "manual";
  if (AFTER_APPROVAL_INTENT.test(words)) return "after-approval";

  return null;
}

export function safariReleaseIntentOf(releaseMode: unknown): SafariReleaseIntentRead {
  const stated = normalizeSafariReleaseIntent(releaseMode);

  return stated ? { intent: stated, source: "store-md" } : { intent: "manual", source: "default" };
}

export function safariApprovalReleaseSentence(read: SafariReleaseIntentRead | null): string {
  if (!read) {
    return "Whether Apple's approval puts the version on sale follows the `- Release:` line under `## Safari` in STORE.md, which could not be read now: `- Release: after approval` puts it on sale at once, and anything else holds it for a release act, which is its own approval.";
  }

  if (read.intent === "after-approval") {
    return "Apple's approval puts the version on sale at once: STORE.md states `- Release: after approval` under `## Safari`, so the review act sets it to release automatically after approval.";
  }

  const cause = read.source === "store-md" ? "STORE.md states `- Release: manual` under `## Safari`" : "STORE.md states no `- Release:` line under `## Safari`";

  return `Apple's approval does not put the version on sale: ${cause}, so the review act sets it to manual release and it waits for a release act (extension_submit {action: "release"}), which is its own approval.`;
}

export async function readSafariReleaseIntent(api: ProjectApi): Promise<SafariReleaseIntentRead | null> {
  const read = await projectApiGet<Record<string, unknown>>(api, "stores/safari/listing").catch(() => null);

  if (!read || !read.ok || !isRow(read.json)) return null;

  const listing = isRow(read.json.listing) ? read.json.listing : {};

  return safariReleaseIntentOf(text(listing.releaseMode));
}

export function platformReleaseSentence(described: string, own: string): string {
  const said = described.split(/(?<=\.)\s+/).filter((sentence) => SAFARI_RELEASE_ON_SALE.test(sentence));

  return said.length ? said.join(" ") : own;
}

export async function readSafariReleaseIntentFor(args: { command: string; project?: string; api?: string }): Promise<SafariReleaseIntentRead | null> {
  const opened = await openProjectApi({ command: args.command, project: args.project, api: args.api }).catch(() => null);

  return opened && opened.ok ? readSafariReleaseIntent(opened.api) : null;
}
