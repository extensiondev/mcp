// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "../lib/cdp";
import { envelope } from "../lib/envelope";
import { isEngineCompanionUrl } from "../lib/guest-load-oracle";
import { isChromiumFamily } from "../lib/browser-family";
import { resolveCdpPort, CDP_PORT_MISSING_HINT } from "../lib/cdp-port";
import { resolveSessionBrowser } from "../lib/session-browser";
import { inspectViaBridge } from "./inspect-gecko";
import { schema } from "./inspect-schema";

export { schema };

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
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        message:
          "No active dev session found. Cannot connect to Chrome DevTools Protocol.",
      },
      hint: `Start a dev session first with extension_dev, then use extension_wait to confirm it is ready. ${CDP_PORT_MISSING_HINT}`,
    });
  }
  const cdpPort = resolved.port;

  const cdp = new CDPClient();

  try {
    const allTargets = await CDPClient.discoverTargets(cdpPort);
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
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-inspectable-target",
        error: {
          code: "E_NO_TARGET",
          message: chromeOnly
            ? "No inspectable page targets found. Only internal chrome:// pages are open; open the extension's surface (or pass a url to navigate a tab) first."
            : "No inspectable page targets found. The extension may not have opened a page yet.",
        },
        value: {
          cdpPort,
          browser,
          allTargets: allTargets.map((t) => ({
            type: t.type,
            url: t.url?.slice(0, 100),
          })),
        },
      });
    }

    const isExtensionSurface = (u: string): boolean =>
      u.startsWith("chrome-extension://") || u.startsWith("moz-extension://");
    /* @invariant With no url, the guest outranks the toolchain.
     *
     * The dev session's first page target is routinely the Extension.js
     * welcome surface: the engine companion's own pages, or the newtab
     * override it installs when the guest has none. Taking pageTargets[0]
     * made this tool silently inspect that toolchain page and report "your
     * extension renders fine" about the wrong document while the guest sat
     * loaded one target over. Default selection therefore ranks the guest's
     * own chrome-extension:// surfaces first, plain web pages second, and
     * override or companion pages last, and anything still ambiguous is
     * named in a warning instead of passed off as the extension. */
    const defaultRank = (u: string): number => {
      if (isEngineCompanionUrl(u)) return 3;
      if (isOverridePage(u)) return 2;
      if (isExtensionSurface(u)) return 0;
      return 1;
    };
    const target = args.url
      ? (pageTargets.find((t) => t.url.includes(args.url!)) ??
        pageTargets.find((t) => !isExtensionSurface(t.url)) ??
        pageTargets[0])
      : pageTargets
          .map((t, index) => ({ t, index, rank: defaultRank(t.url) }))
          .sort((a, b) => a.rank - b.rank || a.index - b.index)[0].t;

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

    let documentUrl = "";
    let toolchainWarning: string | null = null;
    if (!args.url && defaultRank(target.url) >= 2) {
      try {
        const href = await cdp.evaluate(sessionId, "location.href");
        documentUrl = typeof href === "string" ? href : "";
      } catch {
        documentUrl = "";
      }
      toolchainWarning =
        isEngineCompanionUrl(documentUrl) || isEngineCompanionUrl(target.url)
          ? `Inspected ${target.url}, which is rendered by the Extension.js toolchain's own companion extension, not by this project. Pass url, or open one of the extension's surfaces first (extension_open), then inspect again.`
          : `No url was given and only override pages were open, so this inspected ${target.url}. Unless this extension provides that override itself, this is the toolchain's welcome surface, not your extension: pass url or open a surface with extension_open.`;
    }

    const result: Record<string, unknown> = {
      cdpPort,
      browser,
      target: {
        id: target.id,
        url: target.url,
        title: target.title,
        ...(documentUrl && documentUrl !== target.url ? { documentUrl } : {}),
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

    const probeWarning = result.probeWarning;
    delete result.probeWarning;
    return envelope({
      ok: true,
      command: schema.name,
      status: "inspected",
      value: result,
      warnings: [
        typeof probeWarning === "string" ? probeWarning : null,
        toolchainWarning,
      ],
    });
  } catch (err) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "cdp-failed",
      error: {
        code: "E_CDP",
        message: `CDP inspection failed: ${err instanceof Error ? err.message : err}`,
      },
      value: { cdpPort },
      hint: "Ensure a dev session is running. The browser may have closed or the CDP port may have changed.",
    });
  } finally {
    cdp.disconnect();
  }
}
