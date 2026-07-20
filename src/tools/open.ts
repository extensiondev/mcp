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
            : null;
    if (typeof ref === "string" && ref) return ref.replace(/^\.?\//, "");
  }
  return null;
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
    return JSON.stringify({
      ok: false,
      error: {
        name: "NoSurfaceDocument",
        message: `The manifest declares no document for surface "${surface}", so there is no page to render as a tab.`,
      },
      hint: "Check the manifest: popup needs action.default_popup, options needs options_ui.page or options_page, sidebar needs side_panel.default_path.",
    });
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
      parsed.hint =
        `Rendered the ${surface} document in a real tab, which is how you inspect a surface headlessly. ` +
        "It is the same page with the same extension APIs, but it is NOT hosted in a popup window: no popup sizing, and window.close() closes the tab. " +
        "Inspect it with extension_dom_inspect or extension_source_inspect (context: 'page').";
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
    "Open an extension surface or replay an event in a running session. 'popup'/'options'/'sidebar' open UI surfaces. 'action' triggers the toolbar action: opens the action's popup, or (no popup) replays chrome.action.onClicked. 'command' replays a chrome.commands.onCommand keyboard shortcut (pass `name`). NOTE: action/command replay invokes your listener WITHOUT a user gesture, so the gesture-derived activeTab grant does not apply (the result includes gesture:false and a warning when activeTab is declared). Requires the dev session to be started with allowControl: true (extension_dev). Wraps `extension open`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      surface: {
        type: "string",
        enum: ["popup", "options", "sidebar", "action", "command"],
        description: "Which surface to open or event to replay. 'action' triggers the toolbar action; 'command' replays a keyboard-shortcut command (requires `name`).",
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

  const AS_TAB_SURFACES = ["popup", "options", "sidebar"];
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
      if (parsed?.ok === false && /active browser window|no active|headless/i.test(msg)) {
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
                "The dev browser is headless (EXTENSION_HEADLESS), which has no window to attach a popup/sidebar to, so the surface was rendered as a tab instead. Pass asTab: false and relaunch headed for a real popup window.";
              return JSON.stringify(parsedFallback);
            }
          } catch {
            // fall through to the original error
          }
        }
        if (!parsed.hint) {
          parsed.hint =
            "The dev browser is running headless (EXTENSION_HEADLESS), which has no visible window to attach a popup/sidebar to. Retry with asTab: true to render the surface document in a tab, or relaunch a headed dev session for a real popup window.";
        }
        return JSON.stringify(parsed);
      }
    } catch {
      // non-JSON payload; return as-is
    }
  }
  return raw;
}
