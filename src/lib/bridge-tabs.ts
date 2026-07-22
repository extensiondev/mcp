// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb } from "./act";

// A tab as the agent bridge reports it. `tabId` is a NUMERIC chrome.tabs id
// (usable as the `tab` arg everywhere), never a CDP target id; null when the
// engine did not report one.
export interface BridgeTab {
  tabId: number | null;
  url: string;
  title: string;
}

// Enumerate open tabs over the agent bridge (`inspect --list-tabs`), the
// CDP-free discovery path that works on every browser family. Returns the
// engine's own error envelope untouched when the call fails, so callers
// surface the real session diagnosis instead of a re-guessed one.
export async function listBridgeTabs(
  projectPath: string,
  browser: string,
  timeout?: number,
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
    })),
  };
}

// Case-insensitive substring match, url first and title only as a fallback,
// mirroring matchTargetsByUrl so `tabUrl` means the same thing on every
// browser family. Returns the full matching set; the caller decides what
// one/zero/many means.
export function matchTabsByUrl(tabs: BridgeTab[], needle: string): BridgeTab[] {
  const wanted = needle.toLowerCase();
  const byUrl = tabs.filter((t) => t.url.toLowerCase().includes(wanted));
  if (byUrl.length > 0) return byUrl;
  return tabs.filter((t) => t.title.toLowerCase().includes(wanted));
}

// Poll the bridge tab list until some tab reports the URL we navigated to,
// the bridge twin of the CDP pollForTarget: after a cross-process swap the
// pre-navigation state is stale, so a fresh enumeration is the only
// trustworthy success signal.
export async function pollForBridgeTab(
  projectPath: string,
  browser: string,
  url: string,
  budgetMs: number,
): Promise<BridgeTab | null> {
  const deadline = Date.now() + budgetMs;
  const wanted = url.replace(/#.*$/, "");
  for (;;) {
    const listed = await listBridgeTabs(projectPath, browser);
    if ("tabs" in listed) {
      for (const t of listed.tabs) {
        if (t.url === wanted || t.url.startsWith(wanted)) return t;
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Navigate a real tab to a URL over the agent bridge: a background-context
// eval of tabs.update on the active tab (tabs.create when none exists).
// This is the Gecko pairing of the CDP navigateToUrl path; tabs.update needs
// no extra permission, and the settle poll below is the success signal, so
// the eval's own return value is only used opportunistically.
export async function navigateToUrlViaBridge(
  projectPath: string,
  browser: string,
  url: string,
  timeout?: number,
): Promise<string> {
  const expression =
    `(async () => {` +
    ` const api = typeof browser !== "undefined" ? browser : chrome;` +
    ` const tabs = await api.tabs.query({ active: true, currentWindow: true });` +
    ` const active = tabs && tabs[0];` +
    ` const tab = active && active.id != null` +
    ` ? await api.tabs.update(active.id, { url: ${JSON.stringify(url)} })` +
    ` : await api.tabs.create({ url: ${JSON.stringify(url)} });` +
    ` return { tabId: tab && tab.id != null ? tab.id : null };` +
    ` })()`;
  const raw = await runActVerb(
    [
      "eval",
      expression,
      projectPath,
      "--context",
      "background",
      "--browser",
      browser,
      ...(timeout != null ? ["--timeout", String(timeout)] : []),
    ],
    projectPath,
    timeout,
  );
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.ok === false) {
      if (!parsed.hint) {
        parsed.hint =
          "On this browser family URL navigation rides the agent bridge (a background eval of tabs.update), so the dev session must be started with allowEval: true (extension_dev).";
      }
      return JSON.stringify(parsed);
    }
  } catch {
    return raw;
  }

  const settled = await pollForBridgeTab(
    projectPath,
    browser,
    url,
    timeout != null ? Math.min(timeout, 6000) : 6000,
  );
  if (!settled) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "NavigateFailed",
        message: `Navigation to ${url} did not produce a tab reporting that URL. The URL may not exist, or the browser refused the navigation (Firefox rejects privileged about:/chrome: URLs and other extensions' moz-extension: pages).`,
      },
      hint: "Confirm the URL, or discover open tabs with extension_dom_inspect listTabs: true. For an extension page, the path must match the BUILT manifest.",
    });
  }
  return JSON.stringify({
    ok: true,
    navigated: url,
    // A NUMERIC chrome.tabs id, directly usable as the `tab` arg of
    // extension_dom_inspect / extension_eval (unlike the CDP path's targetId).
    tab: { tabId: settled.tabId, url: settled.url, title: settled.title },
    hint: "Inspect it with extension_dom_inspect or extension_eval using url or this numeric tab id (context: 'page'/'content').",
  });
}

// This extension's own base URL (moz-extension://<uuid>/ on Gecko), read from
// the live session via runtime.getURL. The Chrome trick of deriving the id
// from the dist path hash does not exist on Firefox: the internal UUID is
// random per profile, so the running extension is the only source of truth.
export async function resolveBridgeBaseUrl(
  projectPath: string,
  browser: string,
  timeout?: number,
): Promise<string | null> {
  const raw = await runActVerb(
    [
      "eval",
      `(typeof browser !== "undefined" ? browser : chrome).runtime.getURL("")`,
      projectPath,
      "--context",
      "background",
      "--browser",
      browser,
      ...(timeout != null ? ["--timeout", String(timeout)] : []),
    ],
    projectPath,
    timeout,
  );
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.ok && typeof parsed.value === "string" && parsed.value) {
      return parsed.value.endsWith("/") ? parsed.value : `${parsed.value}/`;
    }
  } catch {
    // fall through
  }
  return null;
}
