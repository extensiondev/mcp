import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type { ReadyContract } from "../lib/types";
import { CDPClient } from "../lib/cdp";

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
        default: "chrome",
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

async function findCdpPort(
  projectPath: string,
  browser: string,
): Promise<number | null> {
  const readyPath = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );
  try {
    const contract = JSON.parse(fs.readFileSync(readyPath, "utf8")) as ReadyContract & {
      cdpPort?: number;
    };
    // cdpPort is the browser's real --remote-debugging-port (filled in post-launch).
    // `port` is the rspack dev-server port — NOT CDP — so never use it here.
    if (typeof contract.cdpPort === "number") return contract.cdpPort;
  } catch {
    // No ready.json
  }

  // Try default CDP port
  const defaultPort = 9222;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(defaultPort);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
    socket.connect(defaultPort, "127.0.0.1");
  });
}

export async function handler(args: {
  projectPath: string;
  url?: string;
  probe?: string[];
  include?: string[];
  browser?: string;
  maxBytes?: number;
  deepDom?: boolean;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const include = new Set(args.include ?? ["summary", "meta", "console"]);
  const maxBytes = args.maxBytes ?? 262_144;
  const isChromium = ["chrome", "edge", "chromium-based"].includes(browser);

  if (!isChromium) {
    return JSON.stringify({
      error: `Source inspection for ${browser} uses RDP (Remote Debug Protocol). Currently only Chromium CDP is supported.`,
      hint: "Use --browser=chrome for source inspection, or use the CLI: npx extension dev --source",
    });
  }

  // Find the CDP port
  const cdpPort = await findCdpPort(args.projectPath, browser);
  if (!cdpPort) {
    return JSON.stringify({
      error:
        "No active dev session found. Cannot connect to Chrome DevTools Protocol.",
      hint: "Start a dev session first with extension_dev, then use extension_wait to confirm it is ready.",
    });
  }

  const cdp = new CDPClient();

  try {
    // Discover page targets
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

    // Pick the target to inspect
    const target = args.url
      ? (pageTargets.find((t) => t.url.includes(args.url!)) ?? pageTargets[0])
      : pageTargets[0];

    // Connect to the browser-level WebSocket for full CDP access
    const browserWsUrl = await CDPClient.discoverBrowserWsUrl(cdpPort);
    await cdp.connect(browserWsUrl);

    // Attach to the page target
    const sessionId = await cdp.attachToTarget(target.id);
    await cdp.enableDomains(sessionId);

    // Navigate if requested
    if (args.url && !target.url.includes(args.url)) {
      await cdp.navigate(sessionId, args.url);
      // Brief delay for content scripts to inject
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      // Brief delay to collect console messages
      await new Promise((r) => setTimeout(r, 500));
    }

    // Build response
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

    // Full HTML extraction (includes shadow DOM from extension roots)
    if (include.has("html")) {
      let html = await cdp.getPageHTML(sessionId);
      if (maxBytes > 0 && html.length > maxBytes) {
        html = html.slice(0, maxBytes);
        result.htmlTruncated = true;
      }
      result.html = html;
    }

    // HTML summary (counts without full HTML)
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

    // Page metadata
    if (include.has("meta")) {
      result.meta = await cdp.getPageMeta(sessionId);
    }

    // DOM snapshot (structured tree)
    if (include.has("dom_snapshot")) {
      result.domSnapshot = await cdp.getDomSnapshot(sessionId);
    }

    // Console messages
    if (include.has("console")) {
      result.console = cdp.getConsoleSummary();
    }

    // Extension root / reinject metadata
    if (include.has("extension_roots")) {
      result.extensionRoots = await cdp.getExtensionRootMeta(sessionId);
    }

    // Selector probes
    if (args.probe?.length) {
      result.probes = await cdp.probeSelectors(sessionId, args.probe);
    }

    // --deep-dom: pierce closed shadow roots (CDP, Chromium only). The default
    // path above reads open shadow roots; this recovers the closed ones.
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
