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
  probeSelectorsScript,
  PAGE_HTML_SCRIPT,
  EXTENSION_ROOT_META_SCRIPT,
  domSnapshotScript,
} from "../lib/cdp-page-scripts";
import { normalizeDomSnapshot } from "../lib/cdp";
import {
  restoredTabWarning,
  sessionProfileReused,
} from "../lib/profile-carryover";
import { rdpCollectConsoleMessages, rdpEvaluateInTab, rdpListTabs } from "../lib/rdp";
import { findGeckoTab, geckoTabRef, targetNotFound, type TargetRef } from "../lib/target-pick";
import { summarizeConsoleMessages } from "../lib/console-summary";
import { schema as inspectSchema } from "./inspect-schema";
import { declaredSurfaces } from "./open";
import {
  EXTENSION_ORIGIN,
  surfaceForExtensionUrl,
} from "../lib/extension-surfaces";

const TOOL = inspectSchema.name;

export { surfaceForExtensionUrl };

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
      } catch (e) { (out.failedSections = out.failedSections || []).push({ section: "html", reason: String(e) }); }`,
    );
  }

  if (opts.domSnapshot) {
    parts.push(`try { out.domSnapshot = ${domSnapshotScript(500)}; } catch (e) { (out.failedSections = out.failedSections || []).push({ section: "dom_snapshot", reason: String(e) }); }`);
  }

  if (opts.extensionRoots) {
    parts.push(
      `try { out.extensionRoots = ${EXTENSION_ROOT_META_SCRIPT}; } catch (e) {}`,
    );
  }

  if (opts.probes.length) {
    parts.push(
      `out.probes = ${probeSelectorsScript(opts.probes)};`,
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
        if (sr && sr.mode !== "open") { var full = String(sr.innerHTML); out.closed.push({ host: node.tagName.toLowerCase(), html: full.slice(0, ${cap}), truncated: full.length > ${cap} }); }
        var kids = node.children;
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
        if (sr) { var sk = sr.children; for (var j = 0; j < sk.length; j++) walk(sk[j]); }
      }
      walk(document.documentElement);
      return out;
    })();
  `;
}

export function matchPatternRegexSource(pattern: string): string {
  if (pattern === "<all_urls>") return "^(https?|file|ftp):";

  const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!m) return `^${  pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")  }$`;

  const scheme = m[1] === "*" ? "https?" : m[1];
  const host = m[2] === "*" ? "[^/]*" : m[2].startsWith("*.")
    ? `([^/]*\\.)?${  m[2].slice(2).replace(/[.]/g, "\\.")}`
    : m[2].replace(/[.]/g, "\\.");
  const pathPart = (m[3] ?? "/").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return `^${  scheme  }://${  host  }${pathPart  }$`;
}

export function executeScriptExpression(
  urlFilter: string | undefined,
  code: string,
  tabId?: number,
): string {
  const pick =
    typeof tabId === "number"
      ? `tabs.find(function (t) { return t.id === ${tabId}; })`
      : urlFilter
        ? /\*|<all_urls>/.test(urlFilter)
          ? `tabs.find(function (t) { return new RegExp(${JSON.stringify(matchPatternRegexSource(urlFilter))}).test(String(t.url || "")); })`
          : `tabs.find(function (t) { return String(t.url || "").toLowerCase().indexOf(${JSON.stringify(urlFilter.toLowerCase())}) !== -1; })`
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
      (c: { host?: string; html?: string; truncated?: boolean }) => ({
        host: String(c.host ?? ""),
        type: "closed",
        html: String(c.html ?? ""),
        ...(c.truncated ? { truncated: true } : {}),
      }),
    );

    result.deepDom = true;
    result.closedShadowRootsVisible = frame.api === true;

    if (frame.api !== true) {
      notes.push(
        `deepDom on ${browser}: this content-script context has no openOrClosedShadowRoot, so closed shadow roots could not be seen; an empty list here does not mean there are none.`,
      );
    }

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

async function readTabByTargetId(
  projectPath: string,
  browser: string,
  targetId: string,
  expression: string,
  timeout?: number,
): Promise<{ value: unknown; target: TargetRef } | string> {
  const resolved = await resolveRdpPort(projectPath, browser, { waitMs: 3_000 });

  if (!resolved) {
    return envelope({
      ok: false,
      command: TOOL,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        name: "NoSession",
        message: `No live ${browser} session with a debugger server (RDP) for this project, so targetId has no browser to ask. Start extension_dev and extension_wait for ready.`,
      },
    });
  }

  try {
    const tabs = await rdpListTabs(resolved.port);
    const tab = findGeckoTab(tabs, targetId);
    if (!tab) return targetNotFound(TOOL, targetId, tabs.map(geckoTabRef));

    const outcome = await rdpEvaluateInTab(resolved.port, {
      select: (live) => findGeckoTab(live, targetId),
      expression,
      timeoutMs: timeout ?? 10_000,
    });

    if (!outcome.ok) {
      return envelope({
        ok: false,
        command: TOOL,
        status: "inspect-failed",
        error: { code: "E_RDP", name: outcome.name, message: outcome.message },
        hint: "The tab was found but could not be read over the debugger protocol; it may have navigated or closed. Retry, or list what is open with extension_dom_snapshot listTargets: true.",
      });
    }

    return { value: outcome.value, target: geckoTabRef(tab) };
  } catch (error) {
    return envelope({
      ok: false,
      command: TOOL,
      status: "rdp-failed",
      error: { code: "E_RDP", name: "RdpFailed", message: `Could not reach the tab over RDP: ${error instanceof Error ? error.message : String(error)}` },
      hint: "Confirm the session is ready (extension_wait), then retry.",
    });
  }
}

export async function inspectViaBridge(
  args: {
    projectPath: string;
    url?: string;
    targetId?: string;
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

  const surface = args.url
    ? surfaceForExtensionUrl(args.projectPath, browser, args.url)
    : null;

  if (args.url && !surface && EXTENSION_ORIGIN.test(args.url)) {
    const declared = declaredSurfaces(args.projectPath, browser) ?? [];

    return envelope({
      ok: false,
      command: TOOL,
      status: "no-surface",
      error: {
        code: "E_NO_SURFACE_DOCUMENT",
        name: "NoSurfaceDocument",
        message: `${args.url} is a page inside the extension, and on ${browser} a page inside the extension is read through its own surface relay, but that path matches none of the surface documents the manifest declares${declared.length ? ` (${declared.join(", ")})` : ""}. Script injection cannot reach an extension page at all.`,
      },
      hint: declared.length
        ? `Pass the declared document path (extension_open surface: "${declared[0]}" opens one), or read it with extension_dom_snapshot context: "${declared[0]}".`
        : "Declare the page as a surface in the manifest (action.default_popup, options_ui.page, sidebar_action.default_panel or chrome_url_overrides) and rebuild.",
    });
  }

  if (args.url && !surface) {
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
  const byTargetId = args.targetId
    ? await readTabByTargetId(args.projectPath, browser, args.targetId, expression, args.timeout)
    : null;
  if (typeof byTargetId === "string") return byTargetId;

  let raw = byTargetId ? JSON.stringify({ ok: true, value: byTargetId.value }) : await runActVerb(
    [
      "eval",
      expression,
      args.projectPath,
      "--context",
      surface ? surface.context : "page",
      ...(args.url && !surface ? ["--url", args.url] : []),
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
    transport: byTargetId ? "rdp" : "bridge",
    ...(surface ? { surface: surface.context, document: surface.document } : {}),
  };

  if (value.meta) {
    result.target = { ...(byTargetId ? { targetId: byTargetId.target.targetId } : {}), url: value.meta.url, title: value.meta.title };
    if (include.has("meta")) result.meta = value.meta;
  }

  if (include.has("summary") && value.summary) result.summary = value.summary;

  if (include.has("html") && typeof value.html === "string") {
    result.html = value.html;
    if (value.htmlTruncated) result.htmlTruncated = true;
  }

  if (include.has("dom_snapshot") && value.domSnapshot) {
    const snap = normalizeDomSnapshot(value.domSnapshot, 500);
    result.domSnapshot = Array.isArray(value.domSnapshot) ? value.domSnapshot : snap.nodes;

    if (snap.truncated) {
      result.domSnapshotTruncated = {
        listed: snap.nodes.length,
        totalElements: snap.totalElements,
        maxNodes: snap.maxNodes,
        maxDepth: snap.maxDepth,
      };
    }
  }

  const failedSections: Array<{ section: string; reason: string }> = Array.isArray(value.failedSections)
    ? value.failedSections.filter((f: unknown) => f && typeof f === "object")
    : [];

  if (failedSections.length) {
    result.failedSections = failedSections;

    for (const f of failedSections) {
      notes.push(`${f.section} could not be read: ${f.reason}. Its value is absent, not empty.`);
    }
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

  if (!args.url && !args.targetId && sessionProfileReused(args.projectPath, browser)) {
    result.profileReused = true;
    notes.push(restoredTabWarning(urlFilter ?? "the tab this read landed on"));
  }

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
    status: failedSections.length ? "inspected-partially" : "inspected",
    value: result,
    warnings: [...notes, probeWarning],
  });
}
