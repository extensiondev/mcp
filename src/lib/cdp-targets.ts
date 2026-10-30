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
  "Pass it as `targetId` to extension_screenshot, extension_dom_snapshot, extension_inspect or extension_eval to pick that exact page, or target a tab with `tabUrl` (URL substring) or `url`; if you need a numeric tab id, call extension_dom_snapshot with listTabs: true.";

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

export function filterDocumentTargets(
  raw: Array<{ id: string; type: string; url: string; title: string }>,
): PageTarget[] {
  return raw
    .filter(
      (t) =>
        (t.type === "page" || t.type === "iframe") &&
        !String(t.url ?? "").startsWith("devtools://"),
    )
    .map((t) => ({
      targetId: String(t.id),
      type: String(t.type),
      url: String(t.url ?? ""),
      title: String(t.title ?? ""),
    }));
}

export async function listDocumentTargets(port: number): Promise<PageTarget[]> {
  return filterDocumentTargets(await CDPClient.discoverTargets(port));
}

export function urlPatternMatcher(needle: string): (text: string) => boolean {
  if (!needle.includes("*")) {
    const wanted = needle.toLowerCase();

    return (text) => text.toLowerCase().includes(wanted);
  }

  const literal = needle
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join(".*");
  const expression = new RegExp(`^${literal}$`, "i");

  return (text) => expression.test(text);
}

export function matchTargetsByUrl(
  targets: PageTarget[],
  needle: string,
): PageTarget[] {
  const matches = urlPatternMatcher(needle);
  const byUrl = targets.filter((t) => matches(t.url));
  if (byUrl.length > 0) return byUrl;

  return targets.filter((t) => matches(t.title));
}
