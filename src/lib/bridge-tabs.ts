// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { actFrameJson, runActVerb } from "./act";
import {
  listBridgeTabs,
  matchTabsByUrl,
  navigationConfirmPolicy,
  pollForBridgeTab,
  pollForBridgeTabById,
  tabListUnreadable,
  type BridgeTab,
} from "./bridge-tab-list";
import { WEBKIT_FAMILY } from "./browser-family";
import { envelope } from "./envelope";
import { readGeckoBaseUrlFromProfile } from "./gecko-addon";
import { tabViewFields, tabViewSentence } from "./tab-view";

import type { TabViewFields } from "./tab-view";

export { listBridgeTabs, matchTabsByUrl, pollForBridgeTab };
export type { BridgeTab };

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
              hint: "URL navigation rides the agent bridge, so the dev session needs its control channel: start it with extension_dev without allowControl: false.",
            },
      );
    }

    const value =
      verbFrame.value && typeof verbFrame.value === "object"
        ? verbFrame.value
        : {};
    const tabId = typeof value.tabId === "number" ? value.tabId : null;
    const landed = await pollForBridgeTabById(
      projectPath,
      browser,
      url,
      tabId,
      navigationConfirmPolicy(browser, timeout),
    );

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
              }, but the tab list could not be read afterwards (${landed.unreadable.slice(0, 300)}), so where it landed is unknown.${
                WEBKIT_FAMILY.has(browser) ? " On Safari that list rides the extension's background, which answers slowly right after it wakes, so the read was given 10 s and two tries." : ""
              }`
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

    const shows = `${landed.tab.url}${landed.tab.title ? ` ("${landed.tab.title}")` : ""}`;
    const hiddenNote = tabViewSentence({ tab: tabViewFields(landed.tab).tab });

    return envelope({
      ok: true,
      command: tool,
      status: "navigated",
      value: {
        navigated: url,
        tabId: landed.tab.tabId ?? tabId,
        created: value.created === true,
        via: "navigate",
        ...(landed.redirected ? { redirected: { from: url, to: landed.tab.url } } : {}),
        tab: landed.tab,
      },
      hint: landed.redirected
        ? `The tab landed on ${shows}, not on ${url}: the extension (a declarativeNetRequest redirect rule or a webRequest listener) or the server redirected it there, and that page is what loaded. Read it with extension_inspect (url) or extension_dom_snapshot; content scripts that match the final url run on load.`
        : `The tab reports ${shows}. Whether the page loaded or shows the browser's error page is in that title; read it with extension_inspect (url) to be sure. Content scripts that match it run on load; read them with extension_eval (context: 'content', url) or extension_assert content-script-injected.${hiddenNote && !landed.tab.active ? ` ${hiddenNote}` : ""}`,
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
    ` return { tabId: tab && tab.id != null ? tab.id : null, active: tab ? tab.active : undefined, width: tab ? tab.width : undefined, height: tab ? tab.height : undefined };` +
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

  let view: TabViewFields = {};

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

    view = tabViewFields(parsed?.value);
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
      tab: { tabId: settled.tabId, url: settled.url, title: settled.title, ...view.tab },
      ...(view.viewport ? { viewport: view.viewport } : {}),
    },
    hint: `Inspect it with extension_dom_snapshot or extension_eval using url or this numeric tab id (context: 'page'/'content').${
      tabViewSentence(view) ? ` ${tabViewSentence(view)}` : ""
    }`,
  });
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
