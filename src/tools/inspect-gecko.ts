// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { runActVerb } from "../lib/act";
import { envelope } from "../lib/envelope";
import { listBridgeTabs, navigateToUrlViaBridge } from "../lib/bridge-tabs";
import { resolveRdpPort } from "../lib/cdp-port";
import {
  PAGE_HTML_SCRIPT,
  EXTENSION_ROOT_META_SCRIPT,
  domSnapshotScript,
} from "../lib/cdp-page-scripts";
import { rdpCollectConsoleMessages } from "../lib/rdp";
import { summarizeConsoleMessages } from "../lib/console-summary";
import { schema as inspectSchema } from "./inspect-schema";

const TOOL = inspectSchema.name;

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
    TOOL,
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

  if (args.url) {
    const listed = await listBridgeTabs(
      args.projectPath,
      browser,
      args.timeout,
      TOOL,
    );
    if ("error" in listed) return listed.error;
    const already = listed.tabs.some((t) => t.url.includes(args.url!));
    if (!already) {
      const nav = await navigateToUrlViaBridge(
        args.projectPath,
        browser,
        args.url,
        args.timeout,
        TOOL,
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
    meta: true,
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
    TOOL,
  );
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

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
      TOOL,
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
      return envelope({
        ok: false,
        command: TOOL,
        status: "inspect-failed",
        error: {
          code: "E_BRIDGE",
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
  let probeWarning: string | null = null;
  if (value.probes) {
    result.probes = value.probes;
    const jsLooking = (args.probe ?? []).filter((p) =>
      /^typeof\s|^(chrome|browser|window|document)\.|\(\)|=>|===/.test(p),
    );
    if (jsLooking.length) {
      probeWarning =
        `Probes are CSS selectors run through querySelectorAll against the live page, NOT JavaScript expressions. ` +
        `${jsLooking.map((s) => `"${s}"`).join(", ")} parsed as selectors and will match nothing. To evaluate JS, use extension_eval.`;
    }
  }

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

  return envelope({
    ok: true,
    command: TOOL,
    status: "inspected",
    value: result,
    warnings: [...notes, probeWarning],
  });
}
