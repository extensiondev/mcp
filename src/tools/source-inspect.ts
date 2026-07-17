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
          "CSS selectors to query — returns element counts and samples for each",
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
      error: `Source inspection for ${browser} uses RDP (Remote Debug Protocol). Currently only Chromium CDP is supported.`,
      hint: 'Pass browser: "chrome" (against a Chromium-family dev session).',
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
    const pageTargets = allTargets.filter(
      (t) =>
        t.type === "page" &&
        !t.url.startsWith("chrome://") &&
        !t.url.startsWith("devtools://"),
    );

    if (pageTargets.length === 0) {
      return JSON.stringify({
        cdpPort,
        browser,
        warning:
          "No inspectable page targets found. The extension may not have opened a page yet.",
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
