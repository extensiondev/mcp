// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as sleep } from "node:timers/promises";

import { runActVerb } from "./act";
import { WEBKIT_FAMILY } from "./browser-family";

export interface BridgeTab {
  tabId: number | null;
  url: string;
  title: string;
  active?: boolean;
}

export async function listBridgeTabs(
  projectPath: string,
  browser: string,
  timeout?: number,
  tool = "extension_dom_snapshot",
): Promise<{ tabs: BridgeTab[] } | { error: string }> {
  const raw = await runActVerb(
    [
      "inspect",
      projectPath,
      "--list-tabs",
      "--browser",
      browser,
      ...(timeout != null ? ["--timeout", String(timeout)] : []),
    ],
    projectPath,
    timeout,
    tool,
  );
  let parsed: any;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: raw };
  }

  if (parsed?.ok === false) return { error: raw };

  const list = Array.isArray(parsed?.tabs)
    ? parsed.tabs
    : Array.isArray(parsed?.value)
      ? parsed.value
      : Array.isArray(parsed?.value?.tabs)
        ? parsed.value.tabs
        : null;

  if (!list) return { error: raw };

  return {
    tabs: list.map((t: any) => ({
      tabId:
        typeof t?.tabId === "number"
          ? t.tabId
          : typeof t?.id === "number"
            ? t.id
            : null,
      url: String(t?.url ?? ""),
      title: String(t?.title ?? ""),
      ...(typeof t?.active === "boolean" ? { active: t.active } : {}),
    })),
  };
}

export function matchTabsByUrl(tabs: BridgeTab[], needle: string): BridgeTab[] {
  const wanted = needle.toLowerCase();
  const byUrl = tabs.filter((t) => t.url.toLowerCase().includes(wanted));

  if (byUrl.length > 0) return byUrl;

  return tabs.filter((t) => t.title.toLowerCase().includes(wanted));
}

export async function pollForBridgeTab(
  projectPath: string,
  browser: string,
  url: string,
  budgetMs: number,
): Promise<BridgeTab | null | { unreadable: string }> {
  const deadline = Date.now() + budgetMs;
  const wanted = url.replace(/#.*$/, "");
  let listedOnce = false;
  let lastError: string | null = null;

  for (;;) {
    const listed = await listBridgeTabs(projectPath, browser);

    if ("tabs" in listed) {
      listedOnce = true;

      for (const t of listed.tabs) {
        if (t.url === wanted || t.url.startsWith(wanted)) return t;
      }
    } else {
      lastError = listed.error;
    }

    if (Date.now() >= deadline) {
      return !listedOnce && lastError !== null ? { unreadable: lastError } : null;
    }

    await sleep(250);
  }
}

export function tabListUnreadable(
  polled: BridgeTab | null | { unreadable: string },
): polled is { unreadable: string } {
  return polled !== null && "unreadable" in polled;
}

const LOADED_ELSEWHERE = /^(?:https?|moz-extension|chrome-extension|safari-web-extension):\/\//;

function landedElsewhere(tab: BridgeTab, wanted: string): boolean {
  return tab.url !== wanted && LOADED_ELSEWHERE.test(tab.url);
}

function carriesRequestedUrl(tab: BridgeTab, wanted: string): boolean {
  return tab.url.includes(wanted) || tab.url.includes(encodeURIComponent(wanted));
}

export interface ConfirmReadPolicy {
  budgetMs: number;
  minReads: number;
}

export function navigationConfirmPolicy(browser: string, timeout?: number): ConfirmReadPolicy {
  const ceiling = WEBKIT_FAMILY.has(browser) ? 10_000 : 3_000;

  return {
    budgetMs: timeout != null ? Math.min(timeout, ceiling) : ceiling,
    minReads: WEBKIT_FAMILY.has(browser) ? 2 : 1,
  };
}

export async function pollForBridgeTabById(
  projectPath: string,
  browser: string,
  url: string,
  tabId: number | null,
  policy: ConfirmReadPolicy,
): Promise<{
  tab: BridgeTab | null;
  seen: BridgeTab | null;
  redirected?: boolean;
  unreadable?: string;
}> {
  const deadline = Date.now() + policy.budgetMs;
  const wanted = url.replace(/#.*$/, "");
  let seen: BridgeTab | null = null;
  let listedOnce = false;
  let lastError: string | null = null;
  let reads = 0;

  for (;;) {
    const listed = await listBridgeTabs(projectPath, browser);
    reads += 1;

    if ("tabs" in listed) {
      listedOnce = true;
      const candidates =
        tabId != null ? listed.tabs.filter((t) => t.tabId === tabId) : listed.tabs;

      for (const t of candidates) {
        if (t.url === wanted || t.url.startsWith(wanted)) return { tab: t, seen: t };
        if (tabId == null) continue;

        seen = t;

        if (landedElsewhere(t, wanted) && carriesRequestedUrl(t, wanted)) {
          return { tab: t, seen: t, redirected: true };
        }
      }
    } else {
      lastError = listed.error;
    }

    if (Date.now() >= deadline && reads >= policy.minReads) {
      if (seen && landedElsewhere(seen, wanted)) {
        return { tab: seen, seen, redirected: true };
      }

      return {
        tab: null,
        seen,
        ...(!listedOnce && lastError !== null ? { unreadable: lastError } : {}),
      };
    }

    await sleep(250);
  }
}
