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
import { runActVerb } from "../lib/act";
import {
  listBridgeTabs,
  navigateToUrlViaBridge,
} from "../lib/bridge-tabs";

export const schema = {
  name: "extension_source_inspect",
  description:
    "Inspect a running extension's live state: full HTML (with shadow DOM), DOM structure, content script injection, console messages, and CSS selector queries. Chromium sessions ride Chrome DevTools Protocol; Firefox sessions ride the agent bridge (needs allowEval: true) and cover summary/meta/html/probes, while dom_snapshot, extension_roots, console, and deepDom stay CDP-only. Requires an active dev or start session.",
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
    return inspectViaBridge(args, browser, include, maxBytes);
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

// One page-context expression gathering everything the caller asked for in a
// single bridge round-trip: summary metrics, meta, capped HTML, selector
// probes. Kept a plain (non-async) IIFE so it works on any engine that
// evaluates expressions without awaiting promises.
function buildBridgeInspectExpression(opts: {
  summary: boolean;
  meta: boolean;
  html: boolean;
  probes: string[];
  maxBytes: number;
}): string {
  const parts: string[] = ["const out = {};"];
  if (opts.meta) {
    parts.push(
      `try { out.meta = { url: location.href, title: document.title, readyState: document.readyState }; } catch (e) {}`,
    );
  }
  if (opts.summary) {
    parts.push(
      `try {
        const roots = document.querySelectorAll('#extension-root,[data-extension-root]:not([data-extension-root="extension-js-devtools"])');
        out.summary = {
          htmlLength: document.documentElement.outerHTML.length,
          scriptCount: document.querySelectorAll('script').length,
          styleCount: document.querySelectorAll('style').length,
          linkCount: document.querySelectorAll('link').length,
          extensionRootCount: roots.length,
          bodyChildCount: document.body ? document.body.children.length : 0
        };
      } catch (e) { out.summary = {}; }`,
    );
  }
  if (opts.html) {
    parts.push(
      `try {
        const html = document.documentElement.outerHTML;
        const cap = ${JSON.stringify(opts.maxBytes)};
        out.htmlTruncated = cap > 0 && html.length > cap;
        out.html = out.htmlTruncated ? html.slice(0, cap) : html;
      } catch (e) {}`,
    );
  }
  if (opts.probes.length) {
    parts.push(
      `out.probes = {};
      for (const sel of ${JSON.stringify(opts.probes)}) {
        try {
          const nodes = document.querySelectorAll(sel);
          const first = nodes[0];
          out.probes[sel] = { count: nodes.length, sample: first ? String(first.outerHTML || "").slice(0, 200) : null };
        } catch (e) { out.probes[sel] = { error: String((e && e.message) || e) }; }
      }`,
    );
  }
  parts.push("return out;");
  return `(() => { ${parts.join("\n")} })()`;
}

// The Gecko pairing of the CDP inspection: the same result shape, gathered by
// a page-context eval over the agent bridge. Navigates first (like the CDP
// path does) when the requested url is not already open in any tab.
async function inspectViaBridge(
  args: {
    projectPath: string;
    url?: string;
    probe?: string[];
    include?: string[];
    timeout?: number;
    deepDom?: boolean;
  },
  browser: string,
  include: Set<string>,
  maxBytes: number,
): Promise<string> {
  const notes: string[] = [];
  const cdpOnly = ["dom_snapshot", "extension_roots"].filter((k) =>
    include.has(k),
  );
  if (cdpOnly.length) {
    notes.push(
      `${cdpOnly.join(" and ")} require CDP and are Chromium-only; on ${browser}, extension_dom_inspect's summary reports extension roots and open shadow roots.`,
    );
  }
  if (args.deepDom) {
    notes.push(
      "deepDom (closed shadow roots) requires CDP and is Chromium-only.",
    );
  }
  if (include.has("console")) {
    notes.push(
      `Console capture rides CDP; on ${browser} read extension_logs, where the engine streams console output.`,
    );
  }

  // Parity with the CDP path, which navigates a tab to `url` when it is not
  // already open: check the live tab list first, navigate over the bridge if
  // nothing matches, and only then inspect.
  if (args.url) {
    const listed = await listBridgeTabs(args.projectPath, browser, args.timeout);
    if ("error" in listed) return listed.error;
    const already = listed.tabs.some((t) => t.url.includes(args.url!));
    if (!already) {
      const nav = await navigateToUrlViaBridge(
        args.projectPath,
        browser,
        args.url,
        args.timeout,
      );
      try {
        if (JSON.parse(nav)?.ok !== true) return nav;
      } catch {
        return nav;
      }
    }
  }

  const expression = buildBridgeInspectExpression({
    summary: include.has("summary"),
    meta: true, // always gathered: meta doubles as the target echo
    html: include.has("html"),
    probes: args.probe ?? [],
    maxBytes,
  });
  const raw = await runActVerb(
    [
      "eval",
      expression,
      args.projectPath,
      "--context",
      "page",
      ...(args.url ? ["--url", args.url] : []),
      "--browser",
      browser,
      ...(args.timeout != null ? ["--timeout", String(args.timeout)] : []),
    ],
    args.projectPath,
    args.timeout,
  );
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed?.ok !== true) return raw;

  const value = parsed.value ?? {};
  const result: Record<string, unknown> = {
    browser,
    transport: "bridge",
  };
  if (value.meta) {
    result.target = { url: value.meta.url, title: value.meta.title };
    if (include.has("meta")) result.meta = value.meta;
  }
  if (include.has("summary") && value.summary) result.summary = value.summary;
  if (include.has("html") && typeof value.html === "string") {
    result.html = value.html;
    if (value.htmlTruncated) result.htmlTruncated = true;
  }
  if (value.probes) {
    result.probes = value.probes;
    // Same trap as the CDP path: probes are CSS selectors, and API names
    // happen to parse as descendant selectors. Warn exactly when a probe
    // looks like code.
    const jsLooking = (args.probe ?? []).filter((p) =>
      /^typeof\s|^(chrome|browser|window|document)\.|\(\)|=>|===/.test(p),
    );
    if (jsLooking.length) {
      result.probeWarning =
        `Probes are CSS selectors run through querySelectorAll against the live page, NOT JavaScript expressions. ` +
        `${jsLooking.map((s) => `"${s}"`).join(", ")} parsed as selectors and will match nothing. To evaluate JS, use extension_eval.`;
    }
  }
  if (notes.length) result.notes = notes;
  return JSON.stringify(result);
}
