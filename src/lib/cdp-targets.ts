// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";

// A page target as callers see it: named `targetId` on purpose, never `id`,
// because a bare `id` invites passing it where a numeric chrome.tabs id
// belongs (the exact trap extension_open pre-warns about).
export interface PageTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

// The one-line trap warning, kept in step with extension_open's phrasing so
// the toolset tells one consistent story about the two id spaces.
export const TARGET_ID_NOTE =
  "targetId is a CDP target id, NOT a chrome.tabs id: do not pass it as `tab`. " +
  "Target a tab with `tabUrl` (URL substring) or `url`; if you need a numeric tab id, call extension_dom_inspect with listTabs: true.";

// Only real page targets are inspectable tabs; devtools:// windows and
// worker/iframe targets would read as phantom tabs in a discovery listing.
export function filterPageTargets(
  raw: Array<{ id: string; type: string; url: string; title: string }>,
): PageTarget[] {
  return raw
    .filter(
      (t) => t.type === "page" && !String(t.url ?? "").startsWith("devtools://"),
    )
    .map((t) => ({
      targetId: String(t.id),
      type: String(t.type),
      url: String(t.url ?? ""),
      title: String(t.title ?? ""),
    }));
}

export async function listPageTargets(port: number): Promise<PageTarget[]> {
  return filterPageTargets(await CDPClient.discoverTargets(port));
}

// Case-insensitive substring match, url first and title only as a fallback:
// a needle like "example" must not fan out to every tab whose TITLE happens
// to mention it when a url already matches. Returns the full matching set;
// the caller decides what one/zero/many means. Never picks among several.
export function matchTargetsByUrl(
  targets: PageTarget[],
  needle: string,
): PageTarget[] {
  const wanted = needle.toLowerCase();
  const byUrl = targets.filter((t) => t.url.toLowerCase().includes(wanted));
  if (byUrl.length > 0) return byUrl;
  return targets.filter((t) => t.title.toLowerCase().includes(wanted));
}
