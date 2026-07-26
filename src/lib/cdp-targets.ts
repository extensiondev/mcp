// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";

export interface PageTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

export const TARGET_ID_NOTE =
  "targetId is a CDP target id, NOT a chrome.tabs id: do not pass it as `tab`. " +
  "Target a tab with `tabUrl` (URL substring) or `url`; if you need a numeric tab id, call extension_dom_snapshot with listTabs: true.";

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

export function matchTargetsByUrl(
  targets: PageTarget[],
  needle: string,
): PageTarget[] {
  const wanted = needle.toLowerCase();
  const byUrl = targets.filter((t) => t.url.toLowerCase().includes(wanted));
  if (byUrl.length > 0) return byUrl;
  return targets.filter((t) => t.title.toLowerCase().includes(wanted));
}
