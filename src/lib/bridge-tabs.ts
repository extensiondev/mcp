// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { actFrameJson, runActVerb } from "./act";
import { envelope } from "./envelope";
import { readyContractPath } from "./session-paths";
import { readBuiltManifest } from "./project-manifest";

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

function tabListUnreadable(
  polled: BridgeTab | null | { unreadable: string },
): polled is { unreadable: string } {
  return polled !== null && "unreadable" in polled;
}

async function pollForBridgeTabById(
  projectPath: string,
  browser: string,
  url: string,
  tabId: number | null,
  budgetMs: number,
): Promise<{ tab: BridgeTab | null; seen: BridgeTab | null; unreadable?: string }> {
  const deadline = Date.now() + budgetMs;
  const wanted = url.replace(/#.*$/, "");
  let seen: BridgeTab | null = null;
  let listedOnce = false;
  let lastError: string | null = null;

  for (;;) {
    const listed = await listBridgeTabs(projectPath, browser);

    if ("tabs" in listed) {
      listedOnce = true;
      const candidates =
        tabId != null ? listed.tabs.filter((t) => t.tabId === tabId) : listed.tabs;

      for (const t of candidates) {
        if (t.url === wanted || t.url.startsWith(wanted)) return { tab: t, seen: t };
        if (tabId != null) seen = t;
      }
    } else {
      lastError = listed.error;
    }

    if (Date.now() >= deadline) {
      return {
        tab: null,
        seen,
        ...(!listedOnce && lastError !== null ? { unreadable: lastError } : {}),
      };
    }

    await sleep(250);
  }
}

const UNKNOWN_VERB = /unknown command/i;

export interface NavigateTarget {
  tab?: number;
  newTab?: boolean;
}

export async function navigateToUrlViaBridge(
  projectPath: string,
  browser: string,
  url: string,
  timeout?: number,
  tool = "extension_open",
  target: NavigateTarget = {},
): Promise<string> {
  const viaVerb = await runActVerb(
    [
      "navigate",
      url,
      projectPath,
      ...(target.tab != null ? ["--tab", String(target.tab)] : []),
      ...(target.tab == null && target.newTab ? ["--new-tab"] : []),
      "--browser",
      browser,
      ...(timeout != null ? ["--timeout", String(timeout)] : []),
    ],
    projectPath,
    timeout,
    tool,
  );
  let verbFrame: any;

  try {
    verbFrame = JSON.parse(viaVerb);
  } catch {
    verbFrame = null;
  }

  const verbUnknown =
    verbFrame?.ok === false &&
    UNKNOWN_VERB.test(String(verbFrame?.error?.message ?? ""));

  if (verbFrame && !verbUnknown) {
    if (verbFrame.ok === false) {
      return actFrameJson(
        verbFrame.hint
          ? verbFrame
          : {
              ...verbFrame,
              hint: "URL navigation rides the agent bridge, so the dev session must be started with allowControl: true (extension_dev).",
            },
      );
    }

    const value =
      verbFrame.value && typeof verbFrame.value === "object"
        ? verbFrame.value
        : {};
    const tabId = typeof value.tabId === "number" ? value.tabId : null;
    const landed = await pollForBridgeTabById(projectPath, browser, url, tabId, 3000);

    if (!landed.tab) {
      return envelope({
        ok: false,
        command: tool,
        status: "navigation-unconfirmed",
        error: {
          code: "E_NAVIGATE_FAILED",
          name: "NavigationUnconfirmed",
          message: landed.unreadable
            ? `The engine accepted the navigation to ${url}${
                tabId != null ? ` in tab ${tabId}` : ""
              }, but the tab list could not be read afterwards (${landed.unreadable.slice(0, 300)}), so where it landed is unknown.`
            : `The engine accepted the navigation to ${url}${
                tabId != null ? ` in tab ${tabId}` : ""
              }, but no tab reported that url afterwards${
                landed.seen ? ` (the tab shows ${landed.seen.url || "no url"}${landed.seen.title ? `, "${landed.seen.title}"` : ""})` : ""
              }.`,
        },
        value: { navigated: url, tabId, created: value.created === true, via: "navigate", ...(landed.seen ? { tab: landed.seen } : {}) },
        hint: "Read the tab with extension_dom_snapshot (listTabs: true) to see what it shows; a url nothing serves, or a document the extension does not ship, lands on the browser's error page.",
      });
    }

    return envelope({
      ok: true,
      command: tool,
      status: "navigated",
      value: {
        navigated: url,
        tabId: landed.tab.tabId ?? tabId,
        created: value.created === true,
        via: "navigate",
        tab: landed.tab,
      },
      hint: `The tab reports ${landed.tab.url}${landed.tab.title ? ` ("${landed.tab.title}")` : ""}. Whether the page loaded or shows the browser's error page is in that title; read it with extension_inspect (url) to be sure. Content scripts that match it run on load; read them with extension_eval (context: 'content', url) or extension_assert content-script-injected.`,
    });
  }

  return navigateToUrlViaBackgroundEval(projectPath, browser, url, timeout, tool);
}

async function navigateToUrlViaBackgroundEval(
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
      return actFrameJson(
        parsed.hint
          ? parsed
          : {
              ...parsed,
              hint: "This engine predates the navigate verb, so URL navigation rides a background eval of tabs.update: the dev session must be started with allowEval: true (extension_dev), and an MV3 background that refuses eval by CSP (Safari, strict Chromium builds) cannot navigate this way at all; upgrade the project's Extension.js to one with `extension navigate`.",
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

  if (tabListUnreadable(settled)) {
    return envelope({
      ok: false,
      command: tool,
      status: "navigation-unconfirmed",
      error: {
        code: "E_NAVIGATE_FAILED",
        name: "NavigationUnconfirmed",
        message: `The navigation to ${url} was sent, but the tab list could not be read afterwards (${settled.unreadable.slice(0, 300)}), so where it landed is unknown.`,
      },
      hint: "extension_doctor says whether the session is still up; if it is, read the tabs with extension_dom_snapshot listTabs: true.",
    });
  }

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

const UUIDS_PREF = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\)/;

export function geckoAddonId(projectPath: string, browser: string): string | null {
  const read = readBuiltManifest(projectPath, browser);
  const manifest = read?.manifest as Record<string, any> | undefined;
  const settings =
    manifest?.browser_specific_settings ??
    manifest?.["firefox:browser_specific_settings"] ??
    manifest?.["gecko:browser_specific_settings"] ??
    manifest?.applications;
  const id = settings?.gecko?.id;

  return typeof id === "string" && id ? id : null;
}

export function sessionProfilePath(projectPath: string, browser: string): string | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as Record<string, unknown>;

    return typeof contract.profilePath === "string" && contract.profilePath.trim()
      ? contract.profilePath
      : null;
  } catch {
    return null;
  }
}

export function readGeckoBaseUrlFromProfile(
  projectPath: string,
  browser: string,
): string | null {
  const addonId = geckoAddonId(projectPath, browser);
  const profile = sessionProfilePath(projectPath, browser);
  if (!addonId || !profile) return null;

  let prefs: string;

  try {
    prefs = fs.readFileSync(path.join(profile, "prefs.js"), "utf8");
  } catch {
    return null;
  }

  const match = UUIDS_PREF.exec(prefs);
  if (!match) return null;

  try {
    const map = JSON.parse(JSON.parse(`"${match[1]}"`)) as Record<string, unknown>;
    const uuid = map[addonId];

    return typeof uuid === "string" && uuid ? `moz-extension://${uuid}/` : null;
  } catch {
    return null;
  }
}

export async function resolveBridgeBaseUrl(
  projectPath: string,
  browser: string,
  timeout?: number,
): Promise<string | null> {
  const fromRelay = await resolveBridgeBaseUrlThroughRelay(projectPath, browser, timeout);

  return fromRelay ?? readGeckoBaseUrlFromProfile(projectPath, browser);
}

async function resolveBridgeBaseUrlThroughRelay(
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
  }

  return null;
}
