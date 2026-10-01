// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  runActVerb,
  actFrameJson,
  addWarning,
  patchValue,
  type ActArgs,
} from "../lib/act";
import { envelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";
import { readyContractPath } from "../lib/session-paths";
import { CDPClient } from "../lib/cdp";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import {
  isChromiumFamily,
  isGeckoFamily,
  WEBKIT_FAMILY,
} from "../lib/browser-family";
import { readWebDriverSession, WebDriverClient } from "../lib/webdriver";
import { verifyGuestLoaded } from "../lib/guest-load-oracle";
import { manifestCandidates } from "../lib/project-manifest";
import {
  navigateToUrlViaBridge,
  resolveBridgeBaseUrl,
} from "../lib/bridge-tabs";
import { openSidePanelWithSyntheticGesture } from "../lib/cdp-extension-page";
import { openDevToolsPanel } from "../lib/cdp-devtools";
import { listPageTargets, matchTargetsByUrl } from "../lib/cdp-targets";

export const OVERRIDE_SURFACES = ["newtab", "history", "bookmarks"];

type SettledTarget = {
  id: string;
  url: string;
  title?: string;
  redirectedFrom?: string;
};

async function pollForTarget(
  port: number,
  url: string,
  budgetMs: number,
  navigatedTargetId?: string,
): Promise<SettledTarget | null> {
  const deadline = Date.now() + budgetMs;
  const wanted = url.replace(/#.*$/, "");
  let redirected: SettledTarget | null = null;
  for (;;) {
    try {
      const targets = await CDPClient.discoverTargets(port);
      for (const t of targets) {
        const tUrl = String(t.url ?? "");
        if (t.type !== "page") continue;
        const title = typeof t.title === "string" ? t.title : undefined;
        if (tUrl === wanted || tUrl.startsWith(wanted)) {
          return { id: String(t.id), url: tUrl, title };
        }
        if (
          navigatedTargetId &&
          String(t.id) === navigatedTargetId &&
          tUrl &&
          tUrl !== "about:blank" &&
          !tUrl.startsWith("chrome-error://")
        ) {
          redirected = { id: String(t.id), url: tUrl, title, redirectedFrom: url };
        }
      }
    } catch {
      // transient during the process swap; keep polling
    }
    if (Date.now() >= deadline) return redirected;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* @invariant A tab is disposable when nothing of the user's is in it: a
   blank or new-tab page always, and a page of the extension's own origin only
   when the caller is re-rendering a surface, where the earlier copy of that
   surface is the thing being replaced. A url navigation never takes an
   extension page over: the tab it replaced held the Redux store the panel
   under test was meant to show (ledger entry 21). */
async function landedOnErrorPage(
  port: number,
  targetId: string,
): Promise<{ url: string; title?: string } | null> {
  await new Promise((r) => setTimeout(r, 400));
  try {
    const target = (await CDPClient.discoverTargets(port)).find(
      (t) => String(t.id) === targetId,
    );
    const url = String(target?.url ?? "");
    if (/^(chrome|edge)-error:\/\//.test(url)) {
      return { url, title: typeof target?.title === "string" ? target.title : undefined };
    }
  } catch {
  }
  return null;
}

/* @invariant The browser is asked whether it is headless, because the
   environment this server reads only describes the request: a launcher shim
   on this machine adds --headless=new behind every caller, and a headless
   Chrome closes a popup window before the next call can read it (ledger
   entry 32). HeadlessChrome names itself in /json/version: old headless in
   the Browser field, new headless (--headless=new) only in the User-Agent
   field, so both are read (ledger entry 40). */
async function browserRunsHeadless(
  projectPath: string,
  browser: string,
): Promise<boolean> {
  if (!isChromiumFamily(browser)) return false;
  try {
    const resolved = await resolveCdpPort(projectPath, browser, { waitMs: 2000 });
    if (!resolved) return false;
    const product = await CDPClient.discoverBrowserVersion(resolved.port);
    if (typeof product === "string" && /headless/i.test(product)) return true;
    const agent =
      typeof CDPClient.discoverUserAgent === "function"
        ? await CDPClient.discoverUserAgent(resolved.port)
        : null;
    return typeof agent === "string" && /headless/i.test(agent);
  } catch {
    return false;
  }
}

function isDisposableTab(
  tabUrl: string,
  destination: string,
  reuse: "blank" | "surface",
): boolean {
  if (!tabUrl || tabUrl === "about:blank") return true;
  if (/^chrome:\/\/(newtab|new-tab-page)/.test(tabUrl)) return true;
  if (reuse === "blank") return false;
  const origin = destination.match(/^chrome-extension:\/\/[a-p]{32}\//)?.[0];
  return Boolean(origin && tabUrl.startsWith(origin));
}

export interface NavigateOptions {
  reuse?: "blank" | "surface";
  tab?: number;
}

async function navigateToUrlViaWebDriver(
  projectPath: string,
  browser: string,
  url: string,
): Promise<string> {
  const info = readWebDriverSession(projectPath, browser);
  if (!info) return navigateToUrlViaBridge(projectPath, browser, url);
  const client = new WebDriverClient(info);
  try {
    await client.navigate(url);
    return envelope({
      ok: true,
      command: schema.name,
      status: "navigated",
      value: { browser, url: await client.currentUrl().catch(() => url) },
      hint: "The Safari automation window now shows this page. Content scripts that match it ran on load; read their DOM with extension_eval or extension_assert.",
    });
  } catch (error) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "navigate-failed",
      error: {
        code: "E_NAVIGATE_FAILED",
        name: "NavigateError",
        message: error instanceof Error ? error.message : String(error),
      },
      hint: "The automation window refused the URL or is gone. extension_doctor names which.",
    });
  }
}

export async function navigateToUrl(
  projectPath: string,
  browser: string,
  url: string,
  timeout?: number,
  options: NavigateOptions = {},
): Promise<string> {
  const reuse = options.reuse ?? "blank";
  if (options.tab != null) {
    return navigateToUrlViaBridge(projectPath, browser, url, timeout, schema.name, {
      tab: options.tab,
    });
  }
  if (WEBKIT_FAMILY.has(browser) && readWebDriverSession(projectPath, browser)) {
    return navigateToUrlViaWebDriver(projectPath, browser, url);
  }
  if (!isChromiumFamily(browser)) {
    return navigateToUrlViaBridge(projectPath, browser, url, timeout, schema.name, {
      newTab: true,
    });
  }
  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        name: "NoSession",
        message: `No active dev session / CDP port for ${browser}. Start extension_dev and extension_wait for ready. ${CDP_PORT_MISSING_HINT}`,
      },
    });
  }
  const cdp = new CDPClient();
  try {
    const targets = await CDPClient.discoverTargets(resolved.port);
    const pageTargets = targets.filter(
      (t) => t.type === "page" && !String(t.url || "").startsWith("devtools://"),
    );
    const browserWsUrl = await CDPClient.discoverBrowserWsUrl(resolved.port);
    await cdp.connect(browserWsUrl);

    const reusable = pageTargets.find((t) =>
      isDisposableTab(String(t.url ?? ""), url, reuse),
    );
    let navigatedTargetId: string | undefined;
    let openedNewTab = false;
    if (reusable) {
      navigatedTargetId = String(reusable.id);
      const sessionId = await cdp.attachToTarget(navigatedTargetId);
      await cdp.navigate(sessionId, url);
    } else {
      const created = (await cdp
        .sendCommand("Target.createTarget", { url, background: true })
        .catch(() => cdp.sendCommand("Target.createTarget", { url }))) as
        | { targetId?: string }
        | undefined;
      navigatedTargetId =
        typeof created?.targetId === "string" ? created.targetId : undefined;
      openedNewTab = true;
    }

    const settled = await pollForTarget(
      resolved.port,
      url,
      6000,
      navigatedTargetId,
    );
    /* @invariant A target can match the requested url for an instant and then
       be swapped to the browser's own error page: Edge answered a blocked
       extension page that way and the tool reported it navigated (ledger
       entry 35). The landed target is read once more after it settles, and
       an error page is a refusal with the browser's title as the reason. */
    const blocked = settled
      ? await landedOnErrorPage(resolved.port, settled.id)
      : null;
    if (blocked) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "navigate-blocked",
        error: {
          code: "E_NAVIGATE_FAILED",
          name: "PageBlocked",
          message: `The browser refused ${url} and shows its own error page instead${blocked.title ? ` ("${blocked.title}")` : ""}.`,
        },
        value: { navigated: url, target: { targetId: settled!.id, url: blocked.url, title: blocked.title } },
        hint: "Nothing is rendering the requested document. Read the tab title for the browser's reason (Edge, for one, blocks some extension pages with ERR_BLOCKED_BY_CLIENT); try another browser with extension_dev, or a different document of the same extension.",
      });
    }
    if (!settled) {
      const isExtensionPage = url.startsWith("chrome-extension://");
      return envelope({
        ok: false,
        command: schema.name,
        status: "navigate-failed",
        error: {
          code: "E_NAVIGATE_FAILED",
          name: "NavigateFailed",
          message: `Navigation to ${url} did not produce a live page target. ${
            isExtensionPage
              ? "The URL may not exist in the extension bundle, or Chrome refused the navigation."
              : "The page may have failed to load, or the browser refused the navigation."
          }`,
        },
        hint: isExtensionPage
          ? "Confirm the path exists in the built dist (extension_build / extension_analyze list entrypoints). For an extension page, the path must match the BUILT manifest, which may differ from your source layout."
          : "Confirm the URL loads in a normal browser and that the dev session's browser has network access. Nothing about your extension bundle is implicated in a failed http(s) navigation.",
      });
    }
    return envelope({
      ok: true,
      command: schema.name,
      status: "navigated",
      value: {
        navigated: url,
        ...(openedNewTab ? { openedNewTab: true } : {}),
        ...(settled.redirectedFrom
          ? {
              redirected: { from: settled.redirectedFrom, to: settled.url },
            }
          : {}),
        target: {
          targetId: settled.id,
          title: settled.title,
          url: settled.url,
        },
      },
      hint:
        "Inspect it with extension_dom_snapshot or extension_inspect using url (context: 'page'), they resolve the tab themselves. " +
        "`target.targetId` is a CDP target id, NOT a chrome.tabs id: do not pass it as `tab`. If you need a numeric tab id, call extension_dom_snapshot with listTabs: true.",
    });
  } catch (e) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "navigate-failed",
      error: {
        code: "E_NAVIGATE_ERROR",
        name: "NavigateError",
        message: e instanceof Error ? e.message : String(e),
      },
    });
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}

function unpackedExtensionId(distPath: string): string {
  const digest = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

export async function resolveExtensionId(
  projectPath: string,
  browser: string,
): Promise<string | null> {
  const distPath = readDistPath(projectPath, browser);
  const computedIds: string[] = [];
  if (distPath) {
    computedIds.push(unpackedExtensionId(distPath));
    try {
      const real = fs.realpathSync(distPath);
      if (real !== distPath) computedIds.push(unpackedExtensionId(real));
    } catch {
    }
  }

  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) return computedIds[0] ?? null;

  const ids = new Set<string>();
  try {
    for (const t of await CDPClient.discoverTargets(resolved.port)) {
      const url = String(t.url ?? "");
      if (!url.startsWith("chrome-extension://")) continue;
      const id = url.slice("chrome-extension://".length).split("/")[0];
      if (id) ids.add(id);
    }
  } catch {
  }

  for (const id of computedIds) {
    if (ids.has(id)) return id;
  }
  if (ids.size > 0) {
    const guest = await verifyGuestLoaded(projectPath, browser);
    if (guest.checked && guest.guestIds.length === 1) return guest.guestIds[0];
  }
  if (computedIds.length > 0) return computedIds[0];
  return ids.size === 1 ? [...ids][0] : null;
}

function declaredCommands(projectPath: string, browser: string): string[] | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      const commands = manifest?.commands;
      if (commands && typeof commands === "object") {
        return Object.keys(commands);
      }
      return [];
    } catch {
      continue;
    }
  }
  return null;
}

function readDistPath(projectPath: string, browser: string): string | null {
  try {
    const file = readyContractPath(projectPath, browser);
    const contract = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof contract?.distPath === "string" ? contract.distPath : null;
  } catch {
    return null;
  }
}

export function surfaceDocument(
  projectPath: string,
  browser: string,
  surface: string,
): string | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const action = manifest.action ?? manifest.browser_action;
    const ref =
      surface === "popup" || surface === "action"
        ? action?.default_popup
        : surface === "options"
          ? (manifest.options_ui?.page ?? manifest.options_page)
          : surface === "sidebar"
            ? (manifest.side_panel?.default_path ??
              manifest.sidebar_action?.default_panel)
            : surface === "devtools"
              ? manifest.devtools_page
              : surface === "newtab" || surface === "history" || surface === "bookmarks"
                ? manifest.chrome_url_overrides?.[surface]
                : null;
    if (typeof ref === "string" && ref) return ref.replace(/^\.?\//, "");
  }
  return null;
}

export const SURFACE_MANIFEST_KEYS: Record<string, string> = {
  popup: "action.default_popup",
  options: "options_ui.page (or options_page)",
  sidebar: "side_panel.default_path (or sidebar_action.default_panel)",
  devtools: "devtools_page",
  newtab: "chrome_url_overrides.newtab",
  history: "chrome_url_overrides.history",
  bookmarks: "chrome_url_overrides.bookmarks",
};

export function declaredSurfaces(
  projectPath: string,
  browser: string,
): string[] | null {
  const readable = manifestCandidates(projectPath, browser).some((file) => {
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
      return true;
    } catch {
      return false;
    }
  });
  if (!readable) return null;
  return Object.keys(SURFACE_MANIFEST_KEYS).filter(
    (s) => surfaceDocument(projectPath, browser, s) !== null,
  );
}

function missingSurfaceError(
  projectPath: string,
  browser: string,
  surface: string,
  consequence: string,
): string {
  const declared = declaredSurfaces(projectPath, browser);
  if (declared === null) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-manifest",
      error: {
        code: "E_MANIFEST_NOT_FOUND",
        name: "NoSurfaceDocument",
        message: `No readable manifest was found for this project (checked dist/${browser}, dist, src, and the project root), so the ${surface} document cannot be resolved.`,
      },
      hint: "Check projectPath, or build the project first (extension_build).",
    });
  }
  const key = SURFACE_MANIFEST_KEYS[surface] ?? surface;
  const others = declared.filter((s) => s !== surface);
  const nextVerb =
    surface === "popup"
      ? 'To exercise the toolbar button of a popup-less extension, call extension_open with surface: "action", which replays chrome.action.onClicked. To give the extension a popup, set action.default_popup in the manifest and rebuild.'
      : `To add one, set ${key} in the manifest and rebuild.`;
  return envelope({
    ok: false,
    command: schema.name,
    status: "no-surface",
    error: {
      code: "E_NO_SURFACE_DOCUMENT",
      name: "NoSurfaceDocument",
      message: `This extension declares no ${surface}: nothing in its manifest sets ${key}, ${consequence}. That is how the extension is built, not a failure of the session or the tooling.`,
    },
    value: others.length ? { declaredSurfaces: others } : null,
    hint:
      (others.length
        ? `Surfaces this extension does declare: ${others.join(", ")}; extension_open can target those. `
        : "The manifest declares no other UI surface documents either. ") +
      nextVerb,
  });
}

const POPUP_MIN = 25;
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;

export function clampPopupBounds(
  width: number,
  height: number,
): { width: number; height: number; clamped: boolean } {
  const w = Math.min(Math.max(Math.ceil(width), POPUP_MIN), POPUP_MAX_WIDTH);
  const h = Math.min(Math.max(Math.ceil(height), POPUP_MIN), POPUP_MAX_HEIGHT);
  return { width: w, height: h, clamped: w !== Math.ceil(width) || h !== Math.ceil(height) };
}

async function applyPopupBounds(
  projectPath: string,
  browser: string,
  targetId: string,
): Promise<{ width: number; height: number; clamped: boolean } | null> {
  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) return null;
  const cdp = new CDPClient();
  try {
    const ws = await CDPClient.discoverBrowserWsUrl(resolved.port);
    await cdp.connect(ws);
    const sessionId = await cdp.attachToTarget(targetId);
    const measured = (await cdp.evaluate(
      sessionId,
      `(() => {
        const de = document.documentElement, b = document.body;
        if (!de || !b) return null;
        const prev = de.style.width;
        de.style.width = "fit-content";
        const w = Math.max(de.getBoundingClientRect().width, b.getBoundingClientRect().width);
        const h = Math.max(de.getBoundingClientRect().height, b.getBoundingClientRect().height, b.scrollHeight);
        de.style.width = prev;
        return { w: Math.ceil(w), h: Math.ceil(h) };
      })()`,
    )) as { w?: number; h?: number } | undefined;
    if (
      !measured ||
      typeof measured.w !== "number" ||
      typeof measured.h !== "number" ||
      measured.w <= 0 ||
      measured.h <= 0
    ) {
      return null;
    }
    const bounds = clampPopupBounds(measured.w, measured.h);
    const win = (await cdp.sendCommand("Browser.getWindowForTarget", {
      targetId,
    })) as { windowId?: number } | undefined;
    if (typeof win?.windowId !== "number") return null;
    await cdp.sendCommand("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { width: bounds.width, height: bounds.height },
    });
    const after = (await cdp.sendCommand("Browser.getWindowBounds", {
      windowId: win.windowId,
    })) as { bounds?: { width?: number; height?: number } } | undefined;
    if (
      after?.bounds?.width !== bounds.width ||
      after?.bounds?.height !== bounds.height
    ) {
      return null;
    }
    return bounds;
  } catch {
    return null;
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}

async function openSurfaceAsTab(
  projectPath: string,
  browser: string,
  surface: string,
): Promise<string> {
  const doc = surfaceDocument(projectPath, browser, surface);
  if (!doc) {
    return missingSurfaceError(
      projectPath,
      browser,
      surface,
      "so there is no page to render as a tab",
    );
  }
  let url: string;
  let extensionId: string | null;
  if (isChromiumFamily(browser)) {
    extensionId = await resolveExtensionId(projectPath, browser);
    if (!extensionId) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-extension-id",
        error: {
          code: "E_NO_EXTENSION_ID",
          name: "NoExtensionId",
          message:
            "Could not resolve the extension id from the live session's CDP targets.",
        },
        hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
      });
    }
    url = `chrome-extension://${extensionId}/${doc}`;
  } else {
    const base = await resolveBridgeBaseUrl(projectPath, browser);
    if (!base) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-extension-id",
        error: {
          code: "E_NO_EXTENSION_ID",
          name: "NoExtensionId",
          message:
            "Could not resolve the extension's moz-extension:// base URL from the live session (a background eval of runtime.getURL).",
        },
        hint: "Confirm the session is ready (extension_wait) and was started with allowEval: true (extension_dev).",
      });
    }
    url = `${base}${doc}`;
    extensionId = base.replace(/^.*:\/\//, "").replace(/\/$/, "");
  }
  const raw = await navigateToUrl(projectPath, browser, url, undefined, {
    reuse: "surface",
  });
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.ok) {
      const renderedAsTab: Record<string, unknown> = {
        surface,
        document: doc,
        extensionId,
      };
      patchValue(parsed, { renderedAsTab });
      const target = parsed.value?.target ?? parsed.target;
      let popupBounds: { width: number; height: number; clamped: boolean } | null =
        null;
      if (
        (surface === "popup" || surface === "action") &&
        typeof target?.targetId === "string"
      ) {
        popupBounds = await applyPopupBounds(
          projectPath,
          browser,
          target.targetId,
        );
        if (popupBounds) renderedAsTab.popupBounds = popupBounds;
      }
      const reachIt =
        `Inspect it with extension_dom_snapshot context: '${surface}' (include: ['html']), or extension_inspect with this url. ` +
        `To run code in it, call extension_eval with context: '${surface}' (on Chromium this goes over CDP, which the extension page CSP does not govern); ` +
        "do NOT pass this extension-page url as a tab target for script injection, which cannot reach extension pages.";
      parsed.hint = OVERRIDE_SURFACES.includes(surface)
        ? `Opened the ${surface} override page in a tab, which is the only place the browser ever renders a chrome_url_overrides page, so this is the real surface and not a stand-in. ` +
          reachIt
        : `Rendered the ${surface} document in a real tab, which is how you inspect a surface headlessly. ` +
          (popupBounds
            ? `The window was resized to the popup's content size (${popupBounds.width}x${popupBounds.height}${popupBounds.clamped ? ", clamped to Chrome's 25x25-800x600 popup bounds" : ""}), approximating real popup rendering. This resizes the WHOLE browser window for the session. It is the same page with the same extension APIs, but window.close() closes the tab. `
            : "It is the same page with the same extension APIs, but it is NOT hosted in a popup window: no popup sizing, and window.close() closes the tab. ") +
          reachIt;
      return actFrameJson(parsed);
    }
  } catch {
    // non-JSON payload; return as-is
  }
  return raw;
}

async function confirmSurfaceTarget(
  projectPath: string,
  browser: string,
  surface: string,
  raw: string,
): Promise<string> {
  if (!isChromiumFamily(browser)) return raw;
  const doc = surfaceDocument(projectPath, browser, surface);
  if (!doc) return raw;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed?.ok === false) return raw;
  const resolved = await resolveCdpPort(projectPath, browser);
  const extensionId = resolved
    ? await resolveExtensionId(projectPath, browser)
    : null;
  if (!resolved || !extensionId) return raw;
  const wanted = `chrome-extension://${extensionId}/${doc}`;
  const settled = await pollForTarget(resolved.port, wanted, 3000);
  if (settled) {
    patchValue(parsed, {
      surfaceTarget: { targetId: settled.id, url: settled.url },
    });
    return actFrameJson(parsed);
  }
  return envelope({
    ok: false,
    command: schema.name,
    status: "surface-did-not-open",
    error: {
      code: "E_SURFACE_DID_NOT_OPEN",
      name: "SurfaceDidNotOpen",
      message: `The engine reported the ${surface} as opened, but no page target for ${wanted} appeared within 3s, so nothing is there to inspect.`,
    },
    value: { engineResult: parsed },
    hint: `Retry with asTab: true to render ${doc} in a real tab, which works headed or headless. If you expected a window, check that the session is headed and that the surface is declared in the BUILT manifest.`,
  });
}

export const schema = {
  name: "extension_open",
  description:
    "Open an extension surface, or replay an event, in a running session. Pass surface:'popup', 'options' or 'sidebar' to open a UI surface, or 'newtab', 'history' or 'bookmarks' to open the matching chrome_url_overrides page in a tab (always a tab, resolved by the server, never sent to the engine). On Chromium, when Chrome refuses the sidebar for lack of a user gesture, the server opens the real panel through a synthetic click on the extension's own page and says so in warnings; if that fails too it renders the sidebar document as a tab. Pass surface:'devtools' to open the browser's DevTools on a tab (the one `url` matches, else the first web page) and show the extension's panel there, picked by `panel` title when there are several: Chromium only, over CDP Target.openDevTools, headed or headless; the result names the panel document's url, which extension_eval reads with context 'page' and that url (the panel is no tab, so the tab-based readers do not reach it). Pass surface:'action' to trigger the toolbar action, which opens its popup or replays chrome.action.onClicked when there is none. Pass surface:'command' with `name` to replay a chrome.commands.onCommand shortcut. Note that action and command replay invoke your listener without a user gesture, so the gesture-derived activeTab grant does not apply; the result reports gesture:false and warns when activeTab is declared. Start the session with allowControl:true (extension_dev).",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      surface: {
        type: "string",
        enum: ["popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks", "action", "command"],
        description: "Which surface to open or event to replay.",
      },
      name: {
        type: "string",
        description: "For surface 'command': the chrome.commands name to trigger.",
      },
      panel: {
        type: "string",
        description:
          "For surface 'devtools': the title the extension gave chrome.devtools.panels.create, when it registers more than one panel. Omitted, the extension's first panel is shown.",
      },
      waitMs: {
        type: "number",
        description:
          "For surface 'devtools': how long to wait for the panel to register after DevTools opens (default 15000, up to 120000). Extensions that create their panel on a page event need longer, or `reload`.",
      },
      reload: {
        type: "boolean",
        default: false,
        description:
          "For surface 'devtools': reload the inspected tab once DevTools is open, for extensions that create their panel only when the page reports to them on a load that starts with DevTools open (Preact Devtools). Discards the page state under test.",
      },
      url: {
        type: "string",
        description:
          "Navigate a real tab here instead of opening a surface, in a NEW tab unless `tab` names one (a blank or new-tab page is reused). An absolute url opens as given; a path with no scheme, such as pages/options.html, is resolved against the extension's own origin. Use for content-script test pages, or a surface as a page.",
      },
      tab: {
        type: "number",
        description:
          "With `url`: navigate this chrome.tabs id in place instead of opening a new tab (rides the engine's navigate verb, so the session needs allowControl: true). Without it an existing page is never taken over.",
      },
      asTab: {
        type: "boolean",
        default: false,
        description:
          "popup/options/sidebar: render the surface's document in a real tab instead of a popup window. This is how you inspect a surface HEADLESSLY, and it is applied automatically when a headless session refuses to open one. Same page and APIs, but no popup sizing and window.close() closes the tab.",
      },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

export function sessionIsHeadless(): boolean {
  if (/^(1|true)$/i.test(process.env.EXTENSION_HEADLESS ?? "")) return true;
  return /(^|\s|=)-{1,2}headless\b/i.test(
    process.env.EXTENSION_BROWSER_FLAGS ?? "",
  );
}

const HEADED_RELAUNCH =
  "start a headed session: extension_dev with replace: true, and in the environment set EXTENSION_HEADLESS=0 AND clear EXTENSION_BROWSER_FLAGS (it may carry --headless=new, which keeps the window hidden even with EXTENSION_HEADLESS=0)";

/* @invariant A path with no scheme names a document inside the extension,
   whatever the manifest declares about it: pages/options.html is reachable
   by url even when no surface key points at it. The origin comes from the
   live session (the Chromium id from CDP, the moz-extension base from the
   bridge), the same way the surfaces resolve theirs. */
async function resolveExtensionDocumentUrl(
  projectPath: string,
  browser: string,
  relative: string,
): Promise<string | { refusal: string }> {
  const doc = relative.replace(/^\.?\//, "");
  if (isChromiumFamily(browser)) {
    const extensionId = await resolveExtensionId(projectPath, browser);
    if (extensionId) return `chrome-extension://${extensionId}/${doc}`;
    return {
      refusal: envelope({
        ok: false,
        command: schema.name,
        status: "no-extension-id",
        error: {
          code: "E_NO_EXTENSION_ID",
          name: "NoExtensionId",
          message: `"${relative}" has no scheme, so it was read as a document inside the extension, but the extension id could not be resolved from the live session's CDP targets.`,
        },
        hint: `Confirm the session is ready (extension_wait), or pass the full chrome-extension://<id>/${doc} url. ${CDP_PORT_MISSING_HINT}`,
      }),
    };
  }
  const base = await resolveBridgeBaseUrl(projectPath, browser);
  if (base) return `${base}${doc}`;
  return {
    refusal: envelope({
      ok: false,
      command: schema.name,
      status: "no-extension-id",
      error: {
        code: "E_NO_EXTENSION_ID",
        name: "NoExtensionId",
        message: `"${relative}" has no scheme, so it was read as a document inside the extension, but the extension's moz-extension:// base could not be resolved from the live session.`,
      },
      hint: `Pass the full moz-extension://<uuid>/${doc} url (extension_list_extensions reports the uuid), or start the session with allowEval: true so the base can be read from the background.`,
    }),
  };
}

export async function handler(
  args: ActArgs & {
    surface?: string;
    name?: string;
    panel?: string;
    waitMs?: number;
    reload?: boolean;
    url?: string;
    asTab?: boolean;
  },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  if (args.surface === "devtools") {
    return openDevToolsSurface(args, browser);
  }

  if (args.url) {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(args.url)
      ? args.url
      : await resolveExtensionDocumentUrl(args.projectPath, browser, args.url);
    if (typeof absolute !== "string") return absolute.refusal;
    return navigateToUrl(args.projectPath, browser, absolute, args.timeout, {
      tab: args.tab,
    });
  }

  const AS_TAB_SURFACES = ["popup", "options", "sidebar", ...OVERRIDE_SURFACES];
  /* @invariant An override page has no window of its own: the browser renders
     chrome_url_overrides pages in a tab and nowhere else, and the engine's open
     verb knows only popup, options, sidebar, action and command. Resolving the
     page here and opening it by url is the whole surface, not a fallback, so it
     never reaches the CLI. */
  if (args.surface && OVERRIDE_SURFACES.includes(args.surface)) {
    return openSurfaceAsTab(args.projectPath, browser, args.surface);
  }
  if (args.asTab && args.surface && AS_TAB_SURFACES.includes(args.surface)) {
    return openSurfaceAsTab(args.projectPath, browser, args.surface);
  }
  if (!args.surface) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        name: "BadRequest",
        message:
          "Pass `surface` (popup/options/sidebar/action/command) to open a surface, or `url` to navigate a tab.",
      },
    });
  }

  if (args.surface === "command") {
    const declared = declaredCommands(args.projectPath, browser);
    if (declared && args.name && !declared.includes(args.name)) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "unknown-command",
        error: {
          code: "E_UNKNOWN_COMMAND",
          name: "UnknownCommand",
          message: `"${args.name}" is not declared in the manifest's \`commands\`, so triggering it can only ever be a no-op.`,
        },
        value: { declaredCommands: declared },
        hint: declared.length
          ? `Declared commands are: ${declared.join(", ")}. Check for a typo, or add "${args.name}" to the manifest.`
          : "This manifest declares no commands at all. Add a `commands` block, rebuild, then retry.",
      });
    }
  }

  if (args.surface === "popup") {
    const declared = declaredSurfaces(args.projectPath, browser);
    if (declared && !declared.includes("popup")) {
      return missingSurfaceError(
        args.projectPath,
        browser,
        "popup",
        "so there is no popup to open",
      );
    }
  }

  if (
    ["popup", "options", "sidebar"].includes(args.surface) &&
    !sessionIsHeadless() &&
    (await browserRunsHeadless(args.projectPath, browser))
  ) {
    const asTab = await openSurfaceAsTab(args.projectPath, browser, args.surface);
    try {
      const parsedTab = JSON.parse(asTab);
      if (parsedTab?.ok) {
        addWarning(
          parsedTab,
          `The dev browser reports itself headless, and a headless browser closes a popup window before the next call and never shows an options or sidebar window, so the ${args.surface} was rendered as a tab instead (the same document and APIs). For the real window, ${HEADED_RELAUNCH}.`,
        );
        return actFrameJson(parsedTab);
      }
    } catch {
    }
  }

  const cli = ["open", args.surface, args.projectPath];
  if (args.surface === "command" && args.name) cli.push("--name", args.name);
  cli.push("--browser", browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  const raw = await runActVerb(cli, args.projectPath, args.timeout, schema.name);

  const refusal = readWindowRefusal(raw, args.surface, browser);
  if (refusal) {
    if (
      args.surface === "sidebar" &&
      isChromiumFamily(browser) &&
      refusal.kind === "gesture" &&
      !sessionIsHeadless() &&
      !(await browserRunsHeadless(args.projectPath, browser))
    ) {
      return openSidebarThroughGesture(args.projectPath, browser, refusal.frame);
    }
    if (args.surface === "sidebar" && isGeckoFamily(browser)) {
      return openGeckoSidebar(args.projectPath, browser, refusal.frame, args.timeout);
    }
    const fallback = await openSurfaceAsTab(args.projectPath, browser, args.surface);
    const parsedFallback = tryParseEnvelope(fallback);
    if (parsedFallback?.ok) {
      addWarning(parsedFallback, windowRefusalWarning(refusal, args.surface, browser));
      return actFrameJson(parsedFallback);
    }
    if (!refusal.frame.hint) {
      refusal.frame.hint =
        refusal.kind === "gesture"
          ? "This surface can only open from a real user gesture, which automation cannot produce. Retry with asTab: true to render the surface document in a tab instead."
          : `The dev browser has no window for this surface. Retry with asTab: true to render the surface document in a tab, or for the real window, ${HEADED_RELAUNCH}.`;
    }
    return actFrameJson(refusal.frame);
  }
  if (!AS_TAB_SURFACES.includes(args.surface)) return raw;
  const confirmed = await confirmSurfaceTarget(args.projectPath, browser, args.surface, raw);
  const parsedConfirmed = tryParseEnvelope(confirmed);
  if (parsedConfirmed?.status !== "surface-did-not-open") return confirmed;
  /* @invariant An engine "opened" with no document behind it within 3s is a
     window the browser never showed, which is what a headless browser does
     with an options or popup window whatever the launch flags said (ledger
     entries 32 and 40). The document is rendered in a tab instead and the
     warning says so; the engine's answer rides along for the record. */
  const fallback = await openSurfaceAsTab(args.projectPath, browser, args.surface);
  const parsedFallback = tryParseEnvelope(fallback);
  if (parsedFallback?.ok) {
    addWarning(
      parsedFallback,
      `The engine reported the ${args.surface} as opened, but no document for it appeared within 3s (a headless browser never shows an options or popup window), so the ${args.surface} document was rendered in a tab instead (the same document and APIs). For the real window, ${HEADED_RELAUNCH}.`,
    );
    patchValue(parsedFallback, { engineResult: parsedConfirmed.value?.engineResult ?? null });
    return actFrameJson(parsedFallback);
  }
  return confirmed;
}

type WindowRefusal = {
  kind: "gesture" | "no-window" | "unsupported";
  frame: Record<string, any>;
};

function tryParseEnvelope(raw: string): Record<string, any> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* @invariant Three refusals mean the same thing to the caller, "the window
   did not open", and the tab route answers all three. The gesture code is the
   engine's own; the no-window arm reads the BROWSER's words the engine quotes
   (E_TARGET_NOT_FOUND, "no active browser window", "headless"); the
   unsupported arm is Gecko answering that it cannot open a popup or sidebar
   programmatically ("Popup is disabled", E_NOT_IMPLEMENTED). None of these is
   gated on how the session was launched any more (ledger entry 40). */
function readWindowRefusal(
  raw: string,
  surface: string,
  browser: string,
): WindowRefusal | null {
  if (!["popup", "action", "sidebar", "options"].includes(surface)) return null;
  const gesture = readGestureRefusal(raw);
  if (gesture) return { kind: "gesture", frame: gesture };
  const parsed = tryParseEnvelope(raw);
  if (!parsed || parsed.ok !== false) return null;
  const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
  const message = String(parsed.error?.message ?? "");
  if (code === "E_TARGET_NOT_FOUND" || /active browser window|no active|headless/i.test(message)) {
    return { kind: "no-window", frame: parsed };
  }
  if (isGeckoFamily(browser) && surface !== "options") {
    const unsupported = readUnsupportedRefusal(raw);
    if (unsupported || /popup is disabled|not implemented/i.test(message)) {
      return { kind: "unsupported", frame: parsed };
    }
  }
  return null;
}

function windowRefusalWarning(
  refusal: WindowRefusal,
  surface: string,
  browser: string,
): string {
  const noun = surface === "sidebar" ? "sidebar" : surface === "options" ? "options page" : "popup";
  const said = String(refusal.frame.error?.message ?? "").replace(/\s+/g, " ").trim();
  if (isGeckoFamily(browser)) {
    return refusal.kind === "gesture"
      ? `${browser} opens the ${noun} only from its toolbar; the engine refused with Chromium's gesture wording because it counts every non-Firefox name as Chromium (extension.js ledger 642). The ${noun} document was rendered in a tab instead: the same document and APIs, without the toolbar anchoring.`
      : `${browser} cannot open the ${noun} programmatically (${said}), so the ${noun} document was rendered in a tab instead: the same document and APIs, without the toolbar anchoring.`;
  }
  return refusal.kind === "gesture"
    ? `Chromium opens the ${noun} only from a real user gesture, which automation cannot produce, so the ${noun} document was rendered in a tab instead (the same document and APIs). For the real window, ${HEADED_RELAUNCH} and click the toolbar icon.`
    : `The dev browser has no window to show the ${noun} in (${said}); a headless browser never shows one, so the ${noun} document was rendered in a tab instead (the same document and APIs). For the real window, ${HEADED_RELAUNCH}.`;
}

const DEVTOOLS_PANEL_BUDGET_MS = 15_000;

/* @invariant Chromium's browser-level CDP has Target.openDevTools, which opens
   the real DevTools frontend on a target, headed or headless, and the
   extension's devtools_page loads inside it like it would from a keyboard
   shortcut; the frontend's own panel registry then shows the panel. Firefox's
   protocols have no command that opens its developer tools, so on Gecko the
   honest answer is a refusal, not a stand-in tab (a panel page outside DevTools
   has no chrome.devtools and proves nothing). */
const DEVTOOLS_PANEL_BUDGET_MAX_MS = 120_000;

async function openDevToolsSurface(
  args: ActArgs & { panel?: string; waitMs?: number; reload?: boolean },
  browser: string,
): Promise<string> {
  if (!isChromiumFamily(browser)) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "unsupported",
      error: {
        code: "E_UNSUPPORTED_BROWSER",
        name: "NoDevToolsAutomation",
        message: `${browser} exposes no protocol command that opens its developer tools or an extension panel, so this server cannot open the devtools surface there; Target.openDevTools is Chromium's.`,
      },
      hint: WEBKIT_FAMILY.has(browser)
        ? "Open the Web Inspector by hand in the headed Safari window and switch to the panel; extension_logs shows what the devtools page writes."
        : "Open the developer tools by hand in the headed Firefox window (F12) and switch to the panel, or run the same project on chrome to drive the panel from here; extension_logs (context: ['devtools']) shows what the devtools page writes either way.",
    });
  }
  const doc = surfaceDocument(args.projectPath, browser, "devtools");
  if (!doc) {
    return missingSurfaceError(
      args.projectPath,
      browser,
      "devtools",
      "so there is no DevTools page to register a panel",
    );
  }
  const resolved = await resolveCdpPort(args.projectPath, browser);
  if (!resolved) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        name: "NoSession",
        message: `No active dev session / CDP port for ${browser}. Start extension_dev and extension_wait for ready. ${CDP_PORT_MISSING_HINT}`,
      },
    });
  }
  const extensionId = await resolveExtensionId(args.projectPath, browser);
  if (!extensionId) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-extension-id",
      error: {
        code: "E_NO_EXTENSION_ID",
        name: "NoExtensionId",
        message:
          "Could not resolve the extension id from the live session's CDP targets.",
      },
      hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
    });
  }
  const pages = await listPageTargets(resolved.port).catch(() => []);
  const candidates = args.url
    ? matchTargetsByUrl(pages, args.url)
    : pages.filter(
        (t) =>
          /^https?:/i.test(t.url) ||
          (!t.url.startsWith("chrome-extension://") &&
            !t.url.startsWith("chrome://") &&
            t.url !== "about:blank"),
      );
  const inspected = candidates[0] ?? (args.url ? undefined : pages[0]);
  if (!inspected) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-target",
      error: {
        code: "E_NO_TARGET",
        name: "NoTarget",
        message: args.url
          ? `No open tab matches ${args.url}, so there is nothing to open DevTools on.`
          : "No open tab to inspect: the session has no page target.",
      },
      hint: "Open the page first with extension_open (url: the address), then open the devtools surface with the same url. extension_dom_snapshot with listTargets: true lists what is open.",
    });
  }
  const devtoolsPageUrl = `chrome-extension://${extensionId}/${doc}`;
  const budgetMs =
    typeof args.waitMs === "number" && args.waitMs > 0
      ? Math.min(args.waitMs, DEVTOOLS_PANEL_BUDGET_MAX_MS)
      : typeof args.timeout === "number" && args.timeout > 0
        ? Math.min(args.timeout, DEVTOOLS_PANEL_BUDGET_MS)
        : DEVTOOLS_PANEL_BUDGET_MS;
  const outcome = await openDevToolsPanel(resolved.port, {
    inspectedTargetId: inspected.targetId,
    extensionId,
    devtoolsPageUrl,
    panelTitle: args.panel,
    budgetMs,
    reloadInspected: args.reload === true,
  });
  if (!outcome.opened) {
    if (outcome.stage === "open" || outcome.stage === "frontend") {
      return envelope({
        ok: false,
        command: schema.name,
        status: "cdp-failed",
        error: {
          code: "E_CDP",
          name: "CdpError",
          message: `Target.openDevTools on ${inspected.url} did not open a DevTools frontend: ${outcome.reason}.`,
        },
        hint: "This browser build's protocol lacks or refused Target.openDevTools (Chrome 151 and Edge 154 honor it, headed or headless). Open DevTools by hand in a headed session, or run the project on a current Chrome; extension_logs (context: ['devtools']) reads the devtools page either way.",
      });
    }
    const registered = (outcome.panels ?? []).filter((id) =>
      id.startsWith(`chrome-extension://${extensionId}`),
    );
    return envelope({
      ok: false,
      command: schema.name,
      status: "surface-did-not-open",
      error: {
        code: "E_SURFACE_DID_NOT_OPEN",
        name: "PanelDidNotRegister",
        message:
          outcome.stage === "panel"
            ? `DevTools opened on ${inspected.url} and ${doc} loaded in it, but ${outcome.reason}.${registered.length ? ` Panels this extension did register: ${registered.map((id) => id.slice(`chrome-extension://${extensionId}`.length)).join(", ")}.` : ""}`
            : `DevTools opened on ${inspected.url} and the panel registered, but ${outcome.reason}.`,
      },
      value: {
        inspected: { targetId: inspected.targetId, url: inspected.url },
        devtoolsTargetId: outcome.devtoolsTargetId ?? null,
        panels: outcome.panels ?? [],
      },
      hint:
        args.panel && registered.length
          ? `No panel is titled "${args.panel}"; pass one of the registered titles as \`panel\`, or omit it for the first.`
          : `The devtools page registers panels with chrome.devtools.panels.create; extension_logs (context: ['devtools']) shows what ${doc} wrote or threw. An extension that creates its panel only when the page reports to it (Preact Devtools does, through its content script) needs the page loaded with DevTools already open: retry with reload: true, and waitMs for a longer wait. DevTools stays open on the tab.`,
    });
  }
  const panelUrl = outcome.panelTarget?.url ?? null;
  return envelope({
    ok: true,
    command: schema.name,
    status: "opened",
    value: {
      surface: "devtools",
      inspected: { targetId: inspected.targetId, url: inspected.url, title: inspected.title },
      devtoolsTargetId: outcome.devtoolsTargetId,
      panel: {
        title: outcome.panelTitle,
        id: outcome.panelId,
        targetId: outcome.panelTarget?.targetId ?? null,
        url: panelUrl,
      },
      panels: outcome.panels,
      devtoolsPage: devtoolsPageUrl,
      reloadedInspected: args.reload === true,
    },
    warnings: outcome.panelTarget
      ? []
      : [
          "The panel is shown but its document target had not appeared within 3s; call extension_open surface: \"devtools\" again once it loads to get its url.",
        ],
    hint: panelUrl
      ? `DevTools is open on ${inspected.url} with the "${outcome.panelTitle}" panel shown. Read the panel with extension_eval context: "page", url: "${panelUrl}" (over CDP, with chrome.devtools available); context: "devtools" reads the devtools page itself (${doc}), the hidden document that registered the panel. The panel is an iframe inside DevTools, not a tab, so extension_dom_snapshot and extension_inspect do not reach it.`
      : `DevTools is open on ${inspected.url} with the "${outcome.panelTitle}" panel shown. context: "devtools" on extension_eval reads the devtools page itself (${doc}).`,
  });
}

export const E_USER_GESTURE_REQUIRED = "E_USER_GESTURE_REQUIRED";

function readGestureRefusal(raw: string): Record<string, any> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed?.ok !== false) return null;
  const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
  const message = String(parsed.error?.message ?? "");
  /* @invariant The code is the engine's own name for this refusal and the prose
     arm reads the browser's message, which the engine quotes verbatim
     ("may only be called in response to a user gesture"); neither is CLI copy. */
  return code === E_USER_GESTURE_REQUIRED || /user gesture/i.test(message)
    ? parsed
    : null;
}

function readUnsupportedRefusal(raw: string): Record<string, any> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed?.ok !== false) return null;
  const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
  const message = String(parsed.error?.message ?? "");
  return code === "E_NOT_IMPLEMENTED" || /not available/i.test(message)
    ? parsed
    : null;
}

const GECKO_SIDEBAR_GESTURE =
  "Firefox opens a sidebar_action panel only from a user gesture (the toolbar button or View > Sidebar; Bugzilla 1392624), and the engine's open verb carries none, so it cannot open the panel";

/* @invariant The engine names a Chromium API on a Gecko engine ("sidePanel
   not available (engine: firefox)") and stops there, while the relay can say
   whether the sidebar_action panel is open: an inspect in the sidebar context
   answers only from an open panel. So the panel is asked before anything is
   rendered, an open one is reported as open, and a closed one gets its
   document as a tab through the same path the override pages use, with the
   gesture rule stated instead of a foreign API name (ledger entry 11). */
async function openGeckoSidebar(
  projectPath: string,
  browser: string,
  refusal: Record<string, any>,
  timeout?: number,
): Promise<string> {
  const doc = surfaceDocument(projectPath, browser, "sidebar");
  if (!doc) {
    return missingSurfaceError(
      projectPath,
      browser,
      "sidebar",
      "so there is no sidebar panel to open",
    );
  }
  const probe = await runActVerb(
    [
      "inspect",
      projectPath,
      "--context",
      "sidebar",
      "--include",
      "summary",
      "--browser",
      browser,
      ...(timeout != null ? ["--timeout", String(timeout)] : []),
    ],
    projectPath,
    timeout,
    schema.name,
  );
  let open: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(probe);
    if (parsed?.ok === true) open = parsed;
  } catch {
  }
  if (open) {
    const url =
      typeof open.value?.url === "string"
        ? open.value.url
        : typeof open.value?.meta?.url === "string"
          ? open.value.meta.url
          : undefined;
    return envelope({
      ok: true,
      command: schema.name,
      status: "already-open",
      value: {
        surface: "sidebar",
        document: doc,
        alreadyOpen: true,
        ...(url ? { url } : {}),
      },
      hint: `The sidebar panel is open in the ${browser} window already: read it with extension_dom_snapshot context: 'sidebar' or run code in it with extension_eval context: 'sidebar'. ${GECKO_SIDEBAR_GESTURE}, and it did not need to.`,
    });
  }
  const fallback = await openSurfaceAsTab(projectPath, browser, "sidebar");
  try {
    const parsedFallback = JSON.parse(fallback);
    if (parsedFallback?.ok) {
      addWarning(
        parsedFallback,
        `${GECKO_SIDEBAR_GESTURE}, and the panel is not open now, so the sidebar document was rendered as a tab instead. The DOM is the same document the panel would show; the panel hosting stays unverified. A person opens the real panel from the toolbar button or View > Sidebar.`,
      );
      return actFrameJson(parsedFallback);
    }
  } catch {
  }
  refusal.error = {
    ...(refusal.error ?? {}),
    message: `${GECKO_SIDEBAR_GESTURE}. Rendering the document ${doc} as a tab failed as well.`,
  };
  refusal.hint =
    "Start the session with allowEval: true so the document can be opened by url through the bridge, or open the panel from the toolbar button in the dev browser and read it with extension_dom_snapshot context: 'sidebar'.";
  return actFrameJson(refusal);
}

const SIDEBAR_GESTURE_WARNING =
  "Chrome opens the side panel only from a user gesture and the engine's open verb carries none, so the server opened the extension's own sidebar page in a tab, dispatched a synthetic click on it over CDP and called chrome.sidePanel.open from inside that click, then closed the tab. The panel that opened is the real one; the toolbar wiring (action.onClicked or sidePanel.setPanelBehavior) was not exercised.";

async function openSidebarThroughGesture(
  projectPath: string,
  browser: string,
  refusal: Record<string, any>,
): Promise<string> {
  const doc = surfaceDocument(projectPath, browser, "sidebar");
  const resolved = doc ? await resolveCdpPort(projectPath, browser) : null;
  const extensionId = resolved
    ? await resolveExtensionId(projectPath, browser)
    : null;
  let reason =
    "the sidebar document or the session's CDP port could not be resolved";
  if (doc && resolved && extensionId) {
    const hostUrl = `chrome-extension://${extensionId}/${doc}`;
    const outcome = await openSidePanelWithSyntheticGesture(
      resolved.port,
      hostUrl,
    );
    if (outcome.opened) {
      return envelope({
        ok: true,
        command: schema.name,
        status: "opened",
        value: {
          surface: "sidebar",
          gesture: "synthetic-click",
          surfaceTarget: { targetId: outcome.targetId, url: outcome.url },
        },
        warnings: [SIDEBAR_GESTURE_WARNING],
        hint:
          "Read the panel with extension_dom_snapshot context: 'sidebar' (include: ['html']) or run code in it with extension_eval context: 'sidebar'. To exercise the toolbar path itself, a person must click the toolbar icon in the dev browser.",
      });
    }
    reason = outcome.reason;
  }
  const fallback = await openSurfaceAsTab(projectPath, browser, "sidebar");
  try {
    const parsedFallback = JSON.parse(fallback);
    if (parsedFallback?.ok) {
      addWarning(
        parsedFallback,
        `Chrome opens the side panel only from a user gesture, the engine's open verb carries none, and the server's synthetic click did not open it either (${reason}), so the sidebar document was rendered as a tab instead. The DOM is the same React tree the panel would show; the panel hosting and the toolbar wiring stay unverified. Opening the real panel needs a toolbar click from a person in the dev browser.`,
      );
      return actFrameJson(parsedFallback);
    }
  } catch {
  }
  refusal.hint =
    `Chrome opens the side panel only from a user gesture, which the engine's open verb cannot carry, and the server's synthetic click did not open it either (${reason}). ` +
    (doc && extensionId
      ? `To read the panel page anyway, call extension_open with url: "chrome-extension://${extensionId}/${doc}" and then extension_dom_snapshot context: 'sidebar' on it. `
      : "To read the panel page anyway, open its document by url with extension_open and read it with extension_dom_snapshot context: 'sidebar'. ") +
    "Opening the real panel needs a toolbar click from a person in the dev browser.";
  return actFrameJson(refusal);
}
