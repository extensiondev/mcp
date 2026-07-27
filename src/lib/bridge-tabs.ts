// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { actFrameJson, runActVerb } from "./act";
import { envelope } from "./envelope";

export interface BridgeTab {
  tabId: number | null;
  url: string;
  title: string;
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

export async function navigateToUrlViaBridge(
  projectPath: string,
  browser: string,
  url: string,
  timeout?: number,
  tool = "extension_open",
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
    tool,
  );
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.ok === false) {
      // runActVerb already shaped this into schema 1; only the hint is added.
      return actFrameJson(
        parsed.hint
          ? parsed
          : {
              ...parsed,
              hint: "On this browser family URL navigation rides the agent bridge (a background eval of tabs.update), so the dev session must be started with allowEval: true (extension_dev).",
            },
      );
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
    return envelope({
      ok: false,
      command: tool,
      status: "navigate-failed",
      error: {
        code: "E_NAVIGATE_FAILED",
        name: "NavigateFailed",
        message: `Navigation to ${url} did not produce a tab reporting that URL. The URL may not exist, or the browser refused the navigation (Firefox rejects privileged about:/chrome: URLs and other extensions' moz-extension: pages).`,
      },
      hint: "Confirm the URL, or discover open tabs with extension_dom_snapshot listTabs: true. For an extension page, the path must match the BUILT manifest.",
    });
  }
  return envelope({
    ok: true,
    command: tool,
    status: "navigated",
    value: {
      navigated: url,
      tab: { tabId: settled.tabId, url: settled.url, title: settled.title },
    },
    hint: "Inspect it with extension_dom_snapshot or extension_eval using url or this numeric tab id (context: 'page'/'content').",
  });
}

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
