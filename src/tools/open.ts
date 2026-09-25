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

function isDisposableTab(tabUrl: string, destination: string): boolean {
  if (!tabUrl || tabUrl === "about:blank") return true;
  if (/^chrome:\/\/(newtab|new-tab-page)/.test(tabUrl)) return true;
  const origin = destination.match(/^chrome-extension:\/\/[a-p]{32}\//)?.[0];
  return Boolean(origin && tabUrl.startsWith(origin));
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
): Promise<string> {
  if (WEBKIT_FAMILY.has(browser) && readWebDriverSession(projectPath, browser)) {
    return navigateToUrlViaWebDriver(projectPath, browser, url);
  }
  if (!isChromiumFamily(browser)) {
    return navigateToUrlViaBridge(projectPath, browser, url, timeout);
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
      isDisposableTab(String(t.url ?? ""), url),
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
  const raw = await navigateToUrl(projectPath, browser, url);
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
    "Open an extension surface, or replay an event, in a running session. Pass surface:'popup', 'options' or 'sidebar' to open a UI surface, or 'newtab', 'history' or 'bookmarks' to open the matching chrome_url_overrides page in a tab (always a tab, resolved by the server, never sent to the engine). On Chromium, when Chrome refuses the sidebar for lack of a user gesture, the server opens the real panel through a synthetic click on the extension's own page and says so in warnings; if that fails too it renders the sidebar document as a tab. Pass surface:'action' to trigger the toolbar action, which opens its popup or replays chrome.action.onClicked when there is none. Pass surface:'command' with `name` to replay a chrome.commands.onCommand shortcut. Note that action and command replay invoke your listener without a user gesture, so the gesture-derived activeTab grant does not apply; the result reports gesture:false and warns when activeTab is declared. Start the session with allowControl:true (extension_dev).",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      surface: {
        type: "string",
        enum: ["popup", "options", "sidebar", "newtab", "history", "bookmarks", "action", "command"],
        description: "Which surface to open or event to replay.",
      },
      name: {
        type: "string",
        description: "For surface 'command': the chrome.commands name to trigger.",
      },
      url: {
        type: "string",
        description:
          "Navigate a real tab here instead of opening a surface (Firefox needs allowEval: true). Use for content-script test pages, or a surface as a page: chrome-extension://<id>/popup.html.",
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

export async function handler(
  args: ActArgs & {
    surface?: string;
    name?: string;
    url?: string;
    asTab?: boolean;
  },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  if (args.url)
    return navigateToUrl(args.projectPath, browser, args.url, args.timeout);

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

  const cli = ["open", args.surface, args.projectPath];
  if (args.surface === "command" && args.name) cli.push("--name", args.name);
  cli.push("--browser", browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  const raw = await runActVerb(cli, args.projectPath, args.timeout, schema.name);

  const headless = sessionIsHeadless();
  if (headless && ["popup", "action", "sidebar"].includes(args.surface)) {
    try {
      const parsed = JSON.parse(raw);
      const msg = String(parsed?.error?.message ?? "");
      const code =
        typeof parsed?.error?.code === "string" ? parsed.error.code : "";
      /* @invariant The structured arm reads E_TARGET_NOT_FOUND, not E_NO_TARGET.
         E_NO_TARGET is this package's own code, emitted by extension_inspect;
         no engine has ever put it on a frame, so testing an engine's error
         against it was a branch that could not be taken and it made the prose
         match below look like a fallback when it was the whole test.

         E_TARGET_NOT_FOUND is the engine's real code and is read here for
         honesty rather than coverage, because it still does not arrive for this
         failure. A popup that will not open headless comes back from the guest
         as Unsupported("openPopup: <the browser's own words>"), which the CLI's
         codeForBridgeError maps to E_NOT_IMPLEMENTED, indistinguishable from a
         surface the engine cannot drive at all. So the match below is load
         bearing against the newest engine, not a legacy path waiting on a
         version floor, and it reads the BROWSER's message rather than any CLI
         copy. It retires when the engine names this refusal, not when a pin
         moves. */
      const refusedWindow =
        code === "E_TARGET_NOT_FOUND" ||
        /active browser window|no active|headless|user gesture/i.test(msg);
      if (parsed?.ok === false && refusedWindow) {
        if (AS_TAB_SURFACES.includes(args.surface)) {
          const fallback = await openSurfaceAsTab(
            args.projectPath,
            browser,
            args.surface,
          );
          try {
            const parsedFallback = JSON.parse(fallback);
            if (parsedFallback?.ok) {
              addWarning(
                parsedFallback,
                `The dev browser is headless, and a real popup/sidebar window can only open in a headed session, so the surface was rendered as a tab instead. For the real window, ${HEADED_RELAUNCH}, then open the surface again without asTab.`,
              );
              return actFrameJson(parsedFallback);
            }
          } catch {
            // fall through to the original error
          }
        }
        if (!parsed.hint) {
          parsed.hint = /user gesture/i.test(msg)
            ? "This surface can only open from a real user gesture, which headless automation cannot produce. Retry with asTab: true to render the surface document in a tab instead."
            : `The dev browser is running headless, and a popup/sidebar window needs a headed session. Retry with asTab: true to render the surface document in a tab, or for the real window, ${HEADED_RELAUNCH}.`;
        }
        return actFrameJson(parsed);
      }
    } catch {
      // non-JSON payload; return as-is
    }
  }
  if (!headless && args.surface === "sidebar" && isChromiumFamily(browser)) {
    const refusal = readGestureRefusal(raw);
    if (refusal) {
      return openSidebarThroughGesture(args.projectPath, browser, refusal);
    }
  }
  if (args.surface === "sidebar" && isGeckoFamily(browser)) {
    const refusal = readUnsupportedRefusal(raw);
    if (refusal) {
      return openGeckoSidebar(args.projectPath, browser, refusal, args.timeout);
    }
  }
  return AS_TAB_SURFACES.includes(args.surface)
    ? confirmSurfaceTarget(args.projectPath, browser, args.surface, raw)
    : raw;
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
