// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb } from "../lib/act";
import { listBridgeTabs, navigateToUrlViaBridge } from "../lib/bridge-tabs";
import { resolveRdpPort } from "../lib/cdp-port";
import {
  PAGE_HTML_SCRIPT,
  EXTENSION_ROOT_META_SCRIPT,
  domSnapshotScript,
} from "../lib/cdp-page-scripts";
import { rdpCollectConsoleMessages } from "../lib/rdp";
import { summarizeConsoleMessages } from "../lib/console-summary";

// The Gecko pairing of the CDP inspection, one include at a time:
// summary/meta/html/dom_snapshot/extension_roots/probes ride a page-context
// eval over the agent bridge (the CDP page scripts embedded verbatim),
// console rides the RDP watcher's cached-resource replay, and deepDom rides a
// tabs.executeScript walk in the content-script sandbox, where Firefox
// exposes Element.openOrClosedShadowRoot.

// One page-context expression gathering everything the caller asked for in a
// single bridge round-trip. Kept a plain (non-async) IIFE so it works on any
// engine that evaluates expressions without awaiting promises.
function buildBridgeInspectExpression(opts: {
  summary: boolean;
  meta: boolean;
  html: boolean;
  domSnapshot: boolean;
  extensionRoots: boolean;
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
    // Same serializer as the CDP path: PAGE_HTML_SCRIPT folds the content of
    // open extension-root shadow roots into the markup, which a bare
    // outerHTML read silently drops.
    parts.push(
      `try {
        const html = ${PAGE_HTML_SCRIPT};
        const cap = ${JSON.stringify(opts.maxBytes)};
        out.htmlTruncated = cap > 0 && html.length > cap;
        out.html = out.htmlTruncated ? html.slice(0, cap) : html;
      } catch (e) {}`,
    );
  }
  if (opts.domSnapshot) {
    parts.push(`try { out.domSnapshot = ${domSnapshotScript(500)}; } catch (e) {}`);
  }
  if (opts.extensionRoots) {
    parts.push(
      `try { out.extensionRoots = ${EXTENSION_ROOT_META_SCRIPT}; } catch (e) {}`,
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

// The closed-shadow-root walker, compiled INSIDE the content-script sandbox
// via tabs.executeScript so it sees Element.openOrClosedShadowRoot (a
// privileged getter pages have no access to). Plain ES5: executeScript code
// strings run under the page's parser assumptions. The API check uses the
// `in` operator on purpose: reading the getter off Element.prototype invokes
// it on the prototype and throws (verified live).
function closedShadowWalkerCode(cap: number): string {
  return `
    (function() {
      var out = { api: ("openOrClosedShadowRoot" in Element.prototype), closed: [] };
      function walk(node) {
        if (!node || node.nodeType !== 1) return;
        var sr = null;
        try { sr = node.openOrClosedShadowRoot || null; } catch (e) {}
        if (sr && sr.mode !== "open") out.closed.push({ host: node.tagName.toLowerCase(), html: String(sr.innerHTML).slice(0, ${cap}) });
        var kids = node.children;
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
        if (sr) { var sk = sr.children; for (var j = 0; j < sk.length; j++) walk(sk[j]); }
      }
      walk(document.documentElement);
      return out;
    })();
  `;
}

// Background-context expression: find the target tab, then compile `code` in
// its content-script sandbox via MV2 tabs.executeScript. The content sandbox
// shares the page's DOM, so the inspect scripts read the same tree they read
// under CDP. This is the load-bearing Gecko transport: MV2 has no
// chrome.scripting (so the engine's page-context eval is Unsupported there),
// while MV3 event pages CSP-block bridge evals wholesale.
function executeScriptExpression(
  urlFilter: string | undefined,
  code: string,
): string {
  const pick = urlFilter
    ? `tabs.find(function (t) { return String(t.url || "").toLowerCase().indexOf(${JSON.stringify(urlFilter.toLowerCase())}) !== -1; })`
    : `(tabs.find(function (t) { return t.active; }) || tabs[0])`;
  return `browser.tabs.query({}).then(function (tabs) {
    var tab = ${pick};
    if (!tab) return { error: "no matching tab" };
    return browser.tabs.executeScript(tab.id, { code: ${JSON.stringify(code)} }).then(
      function (results) { return { frames: results }; },
      function (err) { return { error: String((err && err.message) || err) }; }
    );
  })`;
}

async function collectGeckoDeepDom(
  args: { projectPath: string; timeout?: number },
  browser: string,
  urlFilter: string | undefined,
  cap: number,
  result: Record<string, unknown>,
  notes: string[],
): Promise<void> {
  const raw = await runActVerb(
    [
      "eval",
      executeScriptExpression(urlFilter, closedShadowWalkerCode(cap)),
      args.projectPath,
      "--context",
      "background",
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
    parsed = null;
  }
  const value = parsed?.ok === true ? parsed.value : null;
  const frame = Array.isArray(value?.frames) ? value.frames[0] : null;
  if (frame && Array.isArray(frame.closed)) {
    result.closedShadowRoots = frame.closed.map(
      (c: { host?: string; html?: string }) => ({
        host: String(c.host ?? ""),
        type: "closed",
        html: String(c.html ?? ""),
      }),
    );
    result.deepDom = true;
    return;
  }
  const reason =
    value?.error ??
    parsed?.error?.message ??
    "the content-script walk returned nothing";
  notes.push(
    `deepDom failed on ${browser}: ${reason}. The walk runs via tabs.executeScript (MV2) and needs the extension to hold host permissions for the target url.`,
  );
}

async function collectGeckoConsole(
  args: { projectPath: string },
  browser: string,
  urlFilter: string | undefined,
  result: Record<string, unknown>,
  notes: string[],
): Promise<void> {
  const fallbackNote = `Console capture on ${browser} rides the RDP watcher replay and needs a session whose ready contract publishes rdpPort (extension.js 4.0.15+); extension_logs streams the extension's own console either way.`;
  const resolved = await resolveRdpPort(args.projectPath, browser, {
    waitMs: 5_000,
  });
  if (!resolved) {
    notes.push(fallbackNote);
    return;
  }
  try {
    const messages = await rdpCollectConsoleMessages(resolved.port, {
      urlFilter,
    });
    result.console = summarizeConsoleMessages(messages);
    result.rdpPort = resolved.port;
  } catch (error) {
    notes.push(
      `Console capture over RDP failed: ${(error as Error).message}. ${fallbackNote}`,
    );
  }
}

export async function inspectViaBridge(
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
    domSnapshot: include.has("dom_snapshot"),
    extensionRoots: include.has("extension_roots"),
    probes: args.probe ?? [],
    maxBytes,
  });
  let raw = await runActVerb(
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

  // MV2 fallback: the engine's page-context eval needs chrome.scripting, an
  // MV3-only API, so MV2 sessions report Unsupported. The same expression
  // compiled in the tab's content-script sandbox via tabs.executeScript reads
  // the identical DOM (verified live), so the caller never sees the gap.
  let value = parsed?.ok === true ? (parsed.value ?? {}) : null;
  if (
    value === null &&
    /scripting is not available/i.test(String(parsed?.error?.message ?? ""))
  ) {
    raw = await runActVerb(
      [
        "eval",
        executeScriptExpression(args.url, expression),
        args.projectPath,
        "--context",
        "background",
        "--browser",
        browser,
        ...(args.timeout != null ? ["--timeout", String(args.timeout)] : []),
      ],
      args.projectPath,
      args.timeout,
    );
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    const frame = Array.isArray(parsed?.value?.frames)
      ? parsed.value.frames[0]
      : null;
    if (parsed?.ok === true && frame && typeof frame === "object") {
      value = frame;
    } else if (parsed?.ok === true) {
      // The background leg succeeded but the content-script leg did not; a
      // bare {ok: true} would misread as a healthy inspection.
      return JSON.stringify({
        ok: false,
        error: {
          name: "InspectFailed",
          message: String(
            parsed?.value?.error ?? "the content-script inspect returned nothing",
          ),
        },
        hint: "The MV2 fallback inspects via tabs.executeScript, which needs the extension to hold host permissions for the target url.",
      });
    }
  }
  if (value === null) return raw;
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
  if (include.has("dom_snapshot") && value.domSnapshot) {
    result.domSnapshot = value.domSnapshot;
  }
  if (include.has("extension_roots") && value.extensionRoots !== undefined) {
    result.extensionRoots = value.extensionRoots;
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

  // The follow-up transports target the tab the eval actually landed on:
  // args.url when given, else the inspected page's own url from meta.
  const urlFilter =
    args.url ??
    (typeof value.meta?.url === "string" ? value.meta.url : undefined);

  if (include.has("console")) {
    await collectGeckoConsole(args, browser, urlFilter, result, notes);
  }
  if (args.deepDom) {
    const cap = maxBytes > 0 ? maxBytes : 65536;
    await collectGeckoDeepDom(args, browser, urlFilter, cap, result, notes);
  }

  if (notes.length) result.notes = notes;
  return JSON.stringify(result);
}
