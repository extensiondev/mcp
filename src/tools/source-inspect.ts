// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "../lib/cdp";
import { isChromiumFamily } from "../lib/browser-family";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_source_inspect",
  description:
    "Inspect a running extension's live state via Chrome DevTools Protocol: full HTML (with shadow DOM), DOM structure, content script injection, console messages, and CSS selector queries. Requires an active dev or start session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root (must have an active dev session)",
      },
      url: {
        type: "string",
        description:
          "URL to inspect (navigates the browser tab to this URL first)",
      },
      probe: {
        type: "array",
        items: { type: "string" },
        description:
          "CSS selectors to query, returns element counts and samples for each",
      },
      include: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "html",
            "summary",
            "meta",
            "dom_snapshot",
            "console",
            "extension_roots",
          ],
        },
        default: ["summary", "meta", "console"],
        description: "What data to include in the response",
      },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      maxBytes: {
        type: "number",
        default: 262144,
        description: "Truncate HTML output at this byte count (0 = unlimited)",
      },
      deepDom: {
        type: "boolean",
        default: false,
        description:
          "Pierce CLOSED shadow roots via CDP (Chromium only). The default path reads open shadow roots; closed ones need this escape hatch.",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  url?: string;
  probe?: string[];
  include?: string[];
  browser?: string;
  maxBytes?: number;
  deepDom?: boolean;
}): Promise<string> {
  const { browser } = resolveSessionBrowser(
    args.projectPath,
    args.browser,
    "chrome",
  );
  const include = new Set(args.include ?? ["summary", "meta", "console"]);
  const maxBytes = args.maxBytes ?? 262_144;
  if (!isChromiumFamily(browser)) {
    return JSON.stringify({
      error: `Source inspection reads the live DOM over Chrome DevTools Protocol, which ${browser} (Gecko) does not expose. This is a capability limit, not a missing session.`,
      hint: `For the ${browser} session, read runtime state with extension_logs, or extension_eval / extension_dom_inspect (content/page, an open surface like popup/options/sidebar, or an override page like newtab) which work against Firefox over the control channel. To get CDP DOM inspection, run a Chromium-family dev session (extension_dev with browser: "chrome") in parallel.`,
    });
  }

  const resolved = await resolveCdpPort(args.projectPath, browser);
  if (!resolved) {
    return JSON.stringify({
      error:
        "No active dev session found. Cannot connect to Chrome DevTools Protocol.",
      hint: `Start a dev session first with extension_dev, then use extension_wait to confirm it is ready. ${CDP_PORT_MISSING_HINT}`,
    });
  }
  const cdpPort = resolved.port;

  const cdp = new CDPClient();

  try {
    const allTargets = await CDPClient.discoverTargets(cdpPort);
    // Chrome renders a chrome_url_overrides page (new tab, bookmarks, history)
    // at its chrome:// URL, but the DOM is the extension's own surface, so
    // these must be inspectable, not filtered out with the rest of chrome://.
    const OVERRIDE_PAGES = [
      "chrome://newtab/",
      "chrome://new-tab-page/",
      "chrome://bookmarks/",
      "chrome://history/",
    ];
    const isOverridePage = (url: string): boolean =>
      OVERRIDE_PAGES.some((p) => url.startsWith(p));
    const pageTargets = allTargets.filter(
      (t) =>
        t.type === "page" &&
        !t.url.startsWith("devtools://") &&
        (!t.url.startsWith("chrome://") || isOverridePage(t.url)),
    );

    if (pageTargets.length === 0) {
      const chromeOnly = allTargets.some(
        (t) => t.type === "page" && t.url.startsWith("chrome://"),
      );
      return JSON.stringify({
        cdpPort,
        browser,
        warning: chromeOnly
          ? "No inspectable page targets found. Only internal chrome:// pages are open; open the extension's surface (or pass a url to navigate a tab) first."
          : "No inspectable page targets found. The extension may not have opened a page yet.",
        allTargets: allTargets.map((t) => ({
          type: t.type,
          url: t.url?.slice(0, 100),
        })),
      });
    }

    const target = args.url
      ? (pageTargets.find((t) => t.url.includes(args.url!)) ?? pageTargets[0])
      : pageTargets[0];

    const browserWsUrl = await CDPClient.discoverBrowserWsUrl(cdpPort);
    await cdp.connect(browserWsUrl);

    const sessionId = await cdp.attachToTarget(target.id);
    await cdp.enableDomains(sessionId);

    if (args.url && !target.url.includes(args.url)) {
      await cdp.navigate(sessionId, args.url);
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }

    const result: Record<string, unknown> = {
      cdpPort,
      browser,
      target: {
        id: target.id,
        url: target.url,
        title: target.title,
      },
      targets: pageTargets.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
      })),
    };

    if (include.has("html")) {
      let html = await cdp.getPageHTML(sessionId);
      if (maxBytes > 0 && html.length > maxBytes) {
        html = html.slice(0, maxBytes);
        result.htmlTruncated = true;
      }
      result.html = html;
    }

    if (include.has("summary")) {
      const summary = await cdp.evaluate(
        sessionId,
        `(() => {
          try {
            const roots = document.querySelectorAll('#extension-root,[data-extension-root]:not([data-extension-root="extension-js-devtools"])');
            return {
              htmlLength: document.documentElement.outerHTML.length,
              scriptCount: document.querySelectorAll('script').length,
              styleCount: document.querySelectorAll('style').length,
              linkCount: document.querySelectorAll('link').length,
              extensionRootCount: roots.length,
              bodyChildCount: document.body ? document.body.children.length : 0
            };
          } catch { return {}; }
        })()`,
      );
      result.summary = summary;
    }

    if (include.has("meta")) {
      result.meta = await cdp.getPageMeta(sessionId);
    }

    if (include.has("dom_snapshot")) {
      result.domSnapshot = await cdp.getDomSnapshot(sessionId);
    }

    if (include.has("console")) {
      result.console = cdp.getConsoleSummary();
    }

    if (include.has("extension_roots")) {
      result.extensionRoots = await cdp.getExtensionRootMeta(sessionId);
    }

    if (args.probe?.length) {
      result.probes = await cdp.probeSelectors(sessionId, args.probe);
      // Three API-surface-swarm personas passed JS expressions ("typeof
      // chrome.tts") here and read the silent count:0 as "API absent": probes
      // are CSS selectors, and API names happen to parse as descendant
      // selectors. Warn exactly when a probe looks like code.
      const jsLooking = args.probe.filter((p) =>
        /^typeof\s|^(chrome|browser|window|document)\.|\(\)|=>|===/.test(p),
      );
      if (jsLooking.length) {
        result.probeWarning =
          `Probes are CSS selectors run through querySelectorAll against the live page, NOT JavaScript expressions. ` +
          `${jsLooking.map((s) => `"${s}"`).join(", ")} parsed as selectors and will match nothing. To evaluate JS, use extension_eval.`;
      }
    }

    if (args.deepDom) {
      const closed = await cdp.getClosedShadowRoots(
        sessionId,
        maxBytes > 0 ? maxBytes : 65536,
      );
      result.closedShadowRoots = closed;
      result.deepDom = true;
    }

    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({
      error: `CDP inspection failed: ${err instanceof Error ? err.message : err}`,
      cdpPort,
      hint: "Ensure a dev session is running. The browser may have closed or the CDP port may have changed.",
    });
  } finally {
    cdp.disconnect();
  }
}
