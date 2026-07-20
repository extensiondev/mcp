// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";
import { CDPClient } from "../lib/cdp";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { isChromiumFamily } from "../lib/browser-family";

// Navigate a real tab to a URL (Chromium, via CDP) so agents can drive a
// content-script test page, a webNavigation target, or the popup rendered as a
// page (chrome-extension://<id>/popup.html) — the loop the surface-only open
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
    await new Promise((r) => setTimeout(r, 1200));
    const meta = (await cdp
      .getPageMeta(sessionId)
      .catch(() => ({}))) as Record<string, unknown>;
    return JSON.stringify({
      ok: true,
      navigated: url,
      tab: { id: target.id, title: meta.title, url: meta.url || url },
      hint: "Inspect it with extension_dom_inspect or extension_source_inspect (context: 'page').",
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
  args: ActArgs & { surface?: string; name?: string; url?: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  // `url` drives a tab navigation over CDP; `surface` opens an extension surface.
  if (args.url) return navigateToUrl(args.projectPath, browser, args.url);
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
      if (parsed?.ok === false && !parsed.hint && /active browser window|no active|headless/i.test(msg)) {
        parsed.hint =
          "The dev browser is running headless (EXTENSION_HEADLESS), which has no visible window to attach a popup/sidebar to. Relaunch a headed dev session to open UI surfaces.";
        return JSON.stringify(parsed);
      }
    } catch {
      // non-JSON payload; return as-is
    }
  }
  return raw;
}
