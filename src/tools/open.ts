// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runActVerb, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";
import { CDPClient } from "../lib/cdp";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { isChromiumFamily } from "../lib/browser-family";

// Poll the browser's target list until a live page target reports the URL we
// navigated to. This is the only trustworthy success signal for a cross-process
// navigation, since the pre-navigation session goes stale.
async function pollForTarget(
  port: number,
  url: string,
  budgetMs: number,
): Promise<{ id: string; url: string; title?: string } | null> {
  const deadline = Date.now() + budgetMs;
  // Chrome normalizes some URLs (trailing slash, escaping); compare on the
  // path prefix rather than requiring a byte-identical match.
  const wanted = url.replace(/#.*$/, "");
  for (;;) {
    try {
      const targets = await CDPClient.discoverTargets(port);
      for (const t of targets) {
        const tUrl = String(t.url ?? "");
        if (t.type !== "page") continue;
        if (tUrl === wanted || tUrl.startsWith(wanted)) {
          return {
            id: String(t.id),
            url: tUrl,
            title: typeof t.title === "string" ? t.title : undefined,
          };
        }
      }
    } catch {
      // transient during the process swap; keep polling
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Navigate a real tab to a URL (Chromium, via CDP) so agents can drive a
// content-script test page, a webNavigation target, or the popup rendered as a
// page (chrome-extension://<id>/popup.html), the loop the surface-only open
// could not do. Gecko has no CDP; callers use eval(context:page)/logs there.
async function navigateToUrl(
  projectPath: string,
  browser: string,
  url: string,
): Promise<string> {
  if (!isChromiumFamily(browser)) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "Unsupported",
        message: `URL navigation drives a tab over Chrome DevTools Protocol, which ${browser} (Gecko) does not expose. On Firefox, drive the page via extension_eval (context: "page"/"content") or read extension_logs.`,
      },
    });
  }
  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) {
    return JSON.stringify({
      ok: false,
      error: {
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
    if (pageTargets.length === 0) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "NoTab",
          message:
            "The dev browser has no open page tab to navigate. Trigger one (e.g. extension_open surface, or open the extension) first.",
        },
      });
    }
    const target = pageTargets[0];
    const browserWsUrl = await CDPClient.discoverBrowserWsUrl(resolved.port);
    await cdp.connect(browserWsUrl);
    const sessionId = await cdp.attachToTarget(String(target.id));
    await cdp.navigate(sessionId, url);

    // Verify against a FRESH target list, not the attached session. Navigating
    // to a chrome-extension:// origin is cross-process: Chrome swaps the
    // RenderFrameHost, so the session we attached to before the navigation
    // reports stale state (observed: a real, successful popup navigation whose
    // old session still read chrome-error://chromewebdata/). Reading it made
    // this return ok:true on failure AND a wrong url on success.
    const settled = await pollForTarget(resolved.port, url, 6000);
    if (!settled) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "NavigateFailed",
          message: `Navigation to ${url} did not produce a live page target. The URL may not exist in the extension bundle, or Chrome refused the navigation.`,
        },
        hint: "Confirm the path exists in the built dist (extension_build / extension_inspect list entrypoints). For an extension page, the path must match the BUILT manifest, which may differ from your source layout.",
      });
    }
    return JSON.stringify({
      ok: true,
      navigated: url,
      // NOT a chrome.tabs id. This is a CDP target id (hex), and passing it to
      // extension_dom_inspect/extension_eval as `tab` fails, because those take
      // a NUMERIC chrome.tabs id. Naming it `tab.id` invited exactly that
      // mistake, so the field says what it is and the hint says what to use.
      target: {
        targetId: settled.id,
        title: settled.title,
        url: settled.url,
      },
      hint:
        "Inspect it with extension_dom_inspect or extension_source_inspect using url (context: 'page'), they resolve the tab themselves. " +
        "`target.targetId` is a CDP target id, NOT a chrome.tabs id: do not pass it as `tab`. If you need a numeric tab id, call extension_dom_inspect with listTabs: true.",
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: {
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

// Chrome derives an UNPACKED extension's id from the SHA-256 of its absolute
// directory path: the first 16 bytes, each nibble mapped 0-15 onto 'a'-'p'.
// Recomputing it is deterministic and needs no browser round-trip.
function unpackedExtensionId(distPath: string): string {
  const digest = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

// Resolve THIS project's extension id.
//
// Scanning CDP targets for the first chrome-extension:// origin is WRONG: a dev
// session also loads Extension.js's own manager extension, so the first target
// is frequently not the project's. That mistake navigated the popup path
// against the manager's origin and produced ERR_FILE_NOT_FOUND while still
// reporting ok:true (caught only by a live run; the mocked unit test could not
// see it). Derive the id from the dist path the engine actually loaded, and use
// a live target only to confirm or as a last resort.
async function resolveExtensionId(
  projectPath: string,
  browser: string,
): Promise<string | null> {
  const distPath = readDistPath(projectPath, browser);
  const computed = distPath ? unpackedExtensionId(distPath) : null;

  const resolved = await resolveCdpPort(projectPath, browser);
  if (!resolved) return computed;

  const ids = new Set<string>();
  try {
    for (const t of await CDPClient.discoverTargets(resolved.port)) {
      const url = String(t.url ?? "");
      if (!url.startsWith("chrome-extension://")) continue;
      const id = url.slice("chrome-extension://".length).split("/")[0];
      if (id) ids.add(id);
    }
  } catch {
    // fall through to the computed id
  }

  if (computed && ids.has(computed)) return computed;
  if (computed) return computed;
  // No dist path to derive from: only safe when exactly one extension is live.
  return ids.size === 1 ? [...ids][0] : null;
}

// The command names the BUILT manifest declares, or null when we cannot read a
// manifest at all (in which case we must not block the caller on a guess).
function declaredCommands(projectPath: string, browser: string): string[] | null {
  const candidates = [
    path.join(projectPath, "dist", browser, "manifest.json"),
    path.join(projectPath, "dist", "manifest.json"),
    path.join(projectPath, "src", "manifest.json"),
    path.join(projectPath, "manifest.json"),
  ];
  for (const file of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      const commands = manifest?.commands;
      if (commands && typeof commands === "object") {
        return Object.keys(commands);
      }
      // A readable manifest with no commands block is a definitive empty list.
      return [];
    } catch {
      continue;
    }
  }
  return null;
}

// The dist directory the running session loaded, straight from the ready
// contract the engine writes.
function readDistPath(projectPath: string, browser: string): string | null {
  try {
    const file = path.resolve(
      projectPath,
      "dist",
      "extension-js",
      browser,
      "ready.json",
    );
    const contract = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof contract?.distPath === "string" ? contract.distPath : null;
  } catch {
    return null;
  }
}

// The manifest path backing a UI surface, read from the BUILT manifest (dist),
// falling back to src for a project that has not been built yet.
function surfaceDocument(
  projectPath: string,
  browser: string,
  surface: string,
): string | null {
  const candidates = [
    path.join(projectPath, "dist", browser, "manifest.json"),
    path.join(projectPath, "dist", "manifest.json"),
    path.join(projectPath, "src", "manifest.json"),
    path.join(projectPath, "manifest.json"),
  ];
  for (const file of candidates) {
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

// Where in the manifest each document-backed surface is declared, so a
// missing-surface error can point at the exact field instead of a vague
// "check the manifest".
const SURFACE_MANIFEST_KEYS: Record<string, string> = {
  popup: "action.default_popup",
  options: "options_ui.page (or options_page)",
  sidebar: "side_panel.default_path (or sidebar_action.default_panel)",
  newtab: "chrome_url_overrides.newtab",
  history: "chrome_url_overrides.history",
  bookmarks: "chrome_url_overrides.bookmarks",
};

// The document-backed surfaces this extension DOES declare, or null when no
// manifest is readable at all (in which case absence must not be asserted).
function declaredSurfaces(
  projectPath: string,
  browser: string,
): string[] | null {
  const candidates = [
    path.join(projectPath, "dist", browser, "manifest.json"),
    path.join(projectPath, "dist", "manifest.json"),
    path.join(projectPath, "src", "manifest.json"),
    path.join(projectPath, "manifest.json"),
  ];
  const readable = candidates.some((file) => {
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

// A surface the manifest does not back with a document is a fact about the
// extension, not a defect in the session or the tooling; the old error read as
// the latter and sent callers in circles. State what is missing and where it
// would be declared, name the surfaces that DO exist, and point at the verb
// that works today.
function missingSurfaceError(
  projectPath: string,
  browser: string,
  surface: string,
  consequence: string,
): string {
  const declared = declaredSurfaces(projectPath, browser);
  if (declared === null) {
    return JSON.stringify({
      ok: false,
      error: {
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
  return JSON.stringify({
    ok: false,
    error: {
      name: "NoSurfaceDocument",
      message: `This extension declares no ${surface}: nothing in its manifest sets ${key}, ${consequence}. That is how the extension is built, not a failure of the session or the tooling.`,
    },
    ...(others.length ? { declaredSurfaces: others } : {}),
    hint:
      (others.length
        ? `Surfaces this extension does declare: ${others.join(", ")}; extension_open can target those. `
        : "The manifest declares no other UI surface documents either. ") +
      nextVerb,
  });
}

// Chrome popups auto-size to their content inside hard platform bounds.
// Rendering the popup document in a full-size tab breaks any layout that
// depends on that (max-width media queries, fit-content shells), which was the
// deferred "full headless popup-render" gap.
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

// Approximate the popup's real rendering for a popup-as-tab: measure the
// document's preferred content size, clamp to Chrome's popup bounds, and
// resize the tab's WINDOW to it. Window bounds are browser state, so they
// persist after this CDP session detaches (an Emulation override would reset
// on detach). Returns null when it could not verifiably apply; callers must
// then keep saying "no popup sizing" rather than implying fidelity.
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
    // scrollWidth on a block document reports the VIEWPORT width, not the
    // content's preferred width (live run: a 320x180 popup measured as the
    // full window and clamped to 800x600). Chrome sizes popups to the
    // content's preferred/intrinsic size, so measure with a temporary
    // fit-content override on the root only: an inline override on BODY
    // would beat the popup's own authored width (body { width: 320px }
    // measured 127px, shrink-wrapped to its text) and popups conventionally
    // size through body/root CSS.
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
    // Read back: a setWindowBounds the browser ignored must not be reported
    // as popup-faithful rendering.
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

// Headless Chromium has no window chrome to hang a popup on, so `open popup`
// dead-ends there, the single biggest blocker cluster for the headless
// personas. But a popup is just a document: navigating a real tab to
// chrome-extension://<id>/<popup> renders the same page with the same APIs, and
// everything downstream (dom_inspect, eval, screenshots) then works.
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
  const id = await resolveExtensionId(projectPath, browser);
  if (!id) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "NoExtensionId",
        message:
          "Could not resolve the extension id from the live session's CDP targets.",
      },
      hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
    });
  }
  const url = `chrome-extension://${id}/${doc}`;
  const raw = await navigateToUrl(projectPath, browser, url);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.ok) {
      parsed.renderedAsTab = { surface, document: doc, extensionId: id };
      // For a popup, go the extra step: size the window like Chrome would
      // size the popup, so content-fit layouts render as they really would.
      let popupBounds: { width: number; height: number; clamped: boolean } | null =
        null;
      if (
        (surface === "popup" || surface === "action") &&
        typeof parsed.target?.targetId === "string"
      ) {
        popupBounds = await applyPopupBounds(
          projectPath,
          browser,
          parsed.target.targetId,
        );
        if (popupBounds) parsed.renderedAsTab.popupBounds = popupBounds;
      }
      parsed.hint =
        `Rendered the ${surface} document in a real tab, which is how you inspect a surface headlessly. ` +
        (popupBounds
          ? `The window was resized to the popup's content size (${popupBounds.width}x${popupBounds.height}${popupBounds.clamped ? ", clamped to Chrome's 25x25-800x600 popup bounds" : ""}), approximating real popup rendering. This resizes the WHOLE browser window for the session. It is the same page with the same extension APIs, but window.close() closes the tab. `
          : "It is the same page with the same extension APIs, but it is NOT hosted in a popup window: no popup sizing, and window.close() closes the tab. ") +
        `Inspect it with extension_dom_inspect context: '${surface}' (include: ['html']), or extension_source_inspect with this url. ` +
        "Do NOT pass this chrome-extension:// url to extension_dom_inspect or extension_eval as a tab target: script injection cannot reach extension pages, only the surface context or CDP can.";
      return JSON.stringify(parsed);
    }
  } catch {
    // non-JSON payload; return as-is
  }
  return raw;
}

export const schema = {
  name: "extension_open",
  description:
    "Open an extension surface or replay an event in a running session. 'popup'/'options'/'sidebar' open UI surfaces; 'newtab'/'history'/'bookmarks' open the extension's chrome_url_overrides page in a tab. 'action' triggers the toolbar action: opens the action's popup, or (no popup) replays chrome.action.onClicked. 'command' replays a chrome.commands.onCommand keyboard shortcut (pass `name`). NOTE: action/command replay invokes your listener WITHOUT a user gesture, so the gesture-derived activeTab grant does not apply (the result includes gesture:false and a warning when activeTab is declared). Requires the dev session to be started with allowControl: true (extension_dev). Wraps `extension open`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      surface: {
        type: "string",
        enum: ["popup", "options", "sidebar", "newtab", "history", "bookmarks", "action", "command"],
        description: "Which surface to open or event to replay. 'newtab'/'history'/'bookmarks' open the matching chrome_url_overrides page. 'action' triggers the toolbar action; 'command' replays a keyboard-shortcut command (requires `name`).",
      },
      name: {
        type: "string",
        description: "For surface 'command': the chrome.commands name to trigger.",
      },
      url: {
        type: "string",
        description:
          "Navigate a real tab to this URL (Chromium only, via CDP) instead of opening a surface. Use for content-script/webNavigation test pages, or the popup as a page: chrome-extension://<id>/popup.html. Alternative to `surface`.",
      },
      asTab: {
        type: "boolean",
        default: false,
        description:
          "For surface popup/options/sidebar: render the surface's document in a real tab (chrome-extension://<id>/<doc>) instead of opening a real popup window. This is how you inspect a surface HEADLESSLY, where no window exists to host a popup. Applied automatically as a fallback when a headless session refuses to open the surface. Same page and APIs, but no popup sizing and window.close() closes the tab.",
      },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath"],
  },
};

export async function handler(
  args: ActArgs & {
    surface?: string;
    name?: string;
    url?: string;
    asTab?: boolean;
  },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  // `url` drives a tab navigation over CDP; `surface` opens an extension surface.
  if (args.url) return navigateToUrl(args.projectPath, browser, args.url);

  const AS_TAB_SURFACES = ["popup", "options", "sidebar", "newtab", "history", "bookmarks"];
  if (args.asTab && args.surface && AS_TAB_SURFACES.includes(args.surface)) {
    return openSurfaceAsTab(args.projectPath, browser, args.surface);
  }
  if (!args.surface) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "BadRequest",
        message:
          "Pass `surface` (popup/options/sidebar/action/command) to open a surface, or `url` to navigate a tab.",
      },
    });
  }

  // A command name that is not declared in the manifest used to return a green
  // "triggered" and ship a dead keyboard shortcut: the SW never had a listener
  // for it, so nothing happened and nothing said so. Check the built manifest
  // first, and name the commands that DO exist.
  if (args.surface === "command") {
    const declared = declaredCommands(args.projectPath, browser);
    if (declared && args.name && !declared.includes(args.name)) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "UnknownCommand",
          message: `"${args.name}" is not declared in the manifest's \`commands\`, so triggering it can only ever be a no-op.`,
        },
        declaredCommands: declared,
        hint: declared.length
          ? `Declared commands are: ${declared.join(", ")}. Check for a typo, or add "${args.name}" to the manifest.`
          : "This manifest declares no commands at all. Add a `commands` block, rebuild, then retry.",
      });
    }
  }

  // Opening the popup of an extension that declares none used to surface the
  // engine's raw openPopup rejection, which reads as a broken session rather
  // than what it is: the manifest sets no action.default_popup. Say so before
  // shelling out, but only when a manifest is readable; never block on a guess.
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
  const raw = await runActVerb(cli, args.projectPath, args.timeout);

  // Opening a UI surface needs a headed window; under EXTENSION_HEADLESS the
  // engine reports "no active browser window" with no hint as to why. Name the
  // real cause so the caller knows to relaunch headed rather than debug a
  // phantom failure.
  const headless = /^(1|true)$/i.test(process.env.EXTENSION_HEADLESS ?? "");
  if (headless && ["popup", "action", "sidebar"].includes(args.surface)) {
    try {
      const parsed = JSON.parse(raw);
      const msg = String(parsed?.error?.message ?? "");
      // "user gesture" belongs in this branch too: sidePanel.open() headless
      // always hits Chrome's gesture wall, and three API-surface-swarm
      // personas dead-ended on the honest-but-hintless error because this
      // fallback only matched the no-window phrasing.
      if (
        parsed?.ok === false &&
        /active browser window|no active|headless|user gesture/i.test(msg)
      ) {
        // Don't just explain the dead end: headless has no window to hang a
        // popup on, but the surface's document renders fine in a tab. Do that
        // automatically for the surfaces that have one, and say what we did.
        if (AS_TAB_SURFACES.includes(args.surface) && isChromiumFamily(browser)) {
          const fallback = await openSurfaceAsTab(
            args.projectPath,
            browser,
            args.surface,
          );
          try {
            const parsedFallback = JSON.parse(fallback);
            if (parsedFallback?.ok) {
              parsedFallback.note =
                "The dev browser is headless (EXTENSION_HEADLESS=1), and a real popup/sidebar window can only open in a headed session, so the surface was rendered as a tab instead. For the real window, start a headed session: extension_dev with replace: true, with EXTENSION_HEADLESS=0 (or unset) in the environment, then open the surface again without asTab.";
              return JSON.stringify(parsedFallback);
            }
          } catch {
            // fall through to the original error
          }
        }
        if (!parsed.hint) {
          parsed.hint = /user gesture/i.test(msg)
            ? "This surface can only open from a real user gesture, which headless automation cannot produce. Retry with asTab: true to render the surface document in a tab instead."
            : "The dev browser is running headless (EXTENSION_HEADLESS=1), and a popup/sidebar window needs a headed session. Retry with asTab: true to render the surface document in a tab, or start a headed session for the real window: extension_dev with replace: true, with EXTENSION_HEADLESS=0 (or unset) in the environment.";
        }
        return JSON.stringify(parsed);
      }
    } catch {
      // non-JSON payload; return as-is
    }
  }
  return raw;
}
