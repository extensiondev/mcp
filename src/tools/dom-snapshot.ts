// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import {
  runActVerb,
  actFrameJson,
  patchValue,
  type ActArgs,
  addWarning,
} from "../lib/act";
import { envelope } from "../lib/envelope";
import { noSessionEnvelope } from "../lib/production-receipt";
import {
  ambiguousSessionRefusal,
  resolveSessionBrowser,
} from "../lib/session-browser";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import {
  resolveCdpPort,
  resolveRdpPort,
  CDP_PORT_MISSING_HINT,
  RDP_PORT_MISSING_HINT,
} from "../lib/cdp-port";
import {
  listDocumentTargets,
  listPageTargets,
  matchTargetsByUrl,
  TARGET_ID_NOTE,
  type PageTarget,
} from "../lib/cdp-targets";
import { evaluateOnExtensionPage } from "../lib/cdp-extension-page";
import {
  AMBIGUOUS_TARGET_HINT,
  findGeckoTab,
  geckoTabRef,
  geckoTargetId,
  identicalPickWarning,
  pickTarget,
  TARGET_ID_PROPERTY,
  targetNotFound,
} from "../lib/target-pick";
import { rdpEvaluateInTab, rdpListTabs, type RdpTab } from "../lib/rdp";
import {
  EXTENSION_PAGE_CONTEXTS,
  extensionPageUnreachable,
  geckoDocumentTab,
  geckoExtensionTabByUrl,
  mayNameExtensionTab,
  namesExtensionDocument,
  productionSessionCommand,
} from "../lib/extension-surfaces";
import { surfaceDocument } from "./open";
import { listBridgeTabs, matchTabsByUrl } from "../lib/bridge-tabs";

const RDP_ACTOR_NOTE =
  "actor is an RDP tab descriptor actor id, NOT a chrome.tabs id: do not pass it as `tab`. " +
  "Target a tab with `targetId` (its browserId, listed as targetId), `tabUrl` (URL substring) or `url`; if you need a numeric tab id, call extension_dom_snapshot with listTabs: true.";

export const schema = {
  name: "extension_dom_snapshot",
  description:
    "Take a shallow structured DOM snapshot of one chosen surface: element counts, extension roots, open shadow roots, optional byte-capped HTML, and optional recent console lines. This is the SURFACE PICKER: the only tool that reads an open extension surface by name (`context`: popup, options, sidebar, devtools) or an override page, the only one that takes a numeric chrome.tabs id, and the only one that enumerates what is open (listTargets for targetIds, listTabs for numeric tab ids). Pass `targetId` (the target.targetId extension_open answers, or one from listTargets) to read that exact page over the debug port. Not for closed shadow roots, selector probes, navigation or a deep read of an open web page: that is extension_inspect. Not for the pixels: that is extension_screenshot. The snapshot rides the agent bridge (localhost only, on unless extension_dev was called with allowControl:false) and needs no CDP; listTargets and `tabUrl` resolution ask the browser directly and need the session's debug port.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      tab: { type: "number", description: "Numeric chrome.tabs id, only to disambiguate when several tabs match. With neither `tab` nor `url`, content/page target the active tab." },
      url: { type: "string", description: "content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`." },
      tabUrl: {
        type: "string",
        description:
          "Pick the tab by url through the browser's own target list (needs the session's debug port: CDP page targets on Chromium, RDP tab descriptors on Firefox). One that matches several tabs showing the same page reads the most recently active one and warns; one that matches different pages returns the candidates, with their targetIds, instead of guessing.",
      },
      targetId: TARGET_ID_PROPERTY,
      listTargets: {
        type: "boolean",
        default: false,
        description:
          "Enumerate live page targets and return, ignoring the other args. The discovery path for `targetId` and `tabUrl`. Chromium: {targetId,url,title,type}. Firefox: RDP tab descriptors {targetId,actor,url,title,type}. Neither id is a numeric chrome.tabs id; for those use listTabs.",
      },
      listTabs: {
        type: "boolean",
        default: false,
        description:
          "Enumerate open tabs as {tabId,url,title} and return, ignoring the other args. Use when you need a numeric tab id.",
      },
      context: {
        type: "string",
        enum: ["content", "page", "popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks"],
        default: "content",
        description:
          "content/page targets `url`, else the active tab; the rest (popup, options, sidebar, devtools, newtab, history, bookmarks) must already be OPEN, by extension_open. On Firefox, a surface or extension page the bridge cannot reach (an extension_start session's pages carry no relay) is read over the debugger protocol from the tab showing it.",
      },
      include: {
        type: "array",
        items: { type: "string", enum: ["summary", "html"] },
        default: ["summary"],
        description: "What to include; html is byte-capped",
      },
      maxBytes: { type: "number", default: 262144 },
      withConsole: {
        type: ["number", "boolean"],
        description:
          "Also include recent console lines. A number is how many; true means 50.",
      },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

const GECKO_EXTENSION_URL = /^moz-extension:\/\//;

const sameDocumentUrl = (a: unknown, b: string): boolean =>
  String(a ?? "").replace(/[?#].*$/, "") === b.replace(/[?#].*$/, "");

export function protocolSnapshotExpression(
  wantHtml: boolean,
  maxBytes: number,
): string {
  return `(function () {
  var doc = document;
  function countShadow(root) {
    var n = 0, els = root.querySelectorAll("*");
    for (var i = 0; i < els.length; i++) { if (els[i].shadowRoot) { n++; n += countShadow(els[i].shadowRoot); } }
    return n;
  }
  var html = doc.documentElement.outerHTML;
  var snap = {
    context: "page",
    url: String(location.href),
    title: doc.title,
    summary: {
      htmlLength: html.length,
      scriptCount: doc.querySelectorAll("script").length,
      styleCount: doc.querySelectorAll("style,link[rel=stylesheet]").length,
      extensionRootCount: doc.querySelectorAll("#extension-root,[data-extension-root]").length,
      openShadowRoots: countShadow(doc),
      bodyChildCount: doc.body ? doc.body.children.length : 0
    }
  };
  if (${wantHtml ? "true" : "false"}) {
    var cap = ${Math.max(0, Math.floor(maxBytes))};
    if (cap > 0 && html.length > cap) { snap.html = html.slice(0, cap); snap.htmlTruncated = true; }
    else { snap.html = html; }
  }
  return snap;
})()`;
}

function extensionPageTarget(
  args: ActArgs,
  browser: string,
  url: string | undefined,
): { label: string; extensionDocument: boolean; select: (tabs: RdpTab[]) => RdpTab | undefined } | null {
  if (url && GECKO_EXTENSION_URL.test(url)) {
    return { label: url, extensionDocument: true, select: (tabs) => tabs.find((tab) => sameDocumentUrl(tab.url, url)) };
  }

  if (url) {
    if (!mayNameExtensionTab(url)) return null;

    return {
      label: url,
      extensionDocument: namesExtensionDocument(args.projectPath, browser, url),
      select: (tabs) => geckoExtensionTabByUrl(tabs, url),
    };
  }

  const context = args.context;
  if (!context || !EXTENSION_PAGE_CONTEXTS.includes(context)) return null;

  const document = surfaceDocument(args.projectPath, browser, context);

  return document
    ? { label: `the ${context} document (${document})`, extensionDocument: true, select: (tabs) => geckoDocumentTab(tabs, document) }
    : null;
}

async function snapshotExtensionPageOverProtocol(
  args: ActArgs & { include?: string[]; maxBytes?: number },
  browser: string,
  url: string | undefined,
  raw: string,
  consoleAsked: boolean,
): Promise<string | null> {
  if (!isGeckoFamily(browser)) return null;

  const target = extensionPageTarget(args, browser, url);
  if (!target) return null;

  try {
    const refused = JSON.parse(raw);
    if (!refused || refused.ok !== false) return null;
    if (!(url && GECKO_EXTENSION_URL.test(url)) && !["E_TARGET_NOT_FOUND", "E_PAGE_NOT_SCRIPTABLE", "E_EXTENSION_PAGE_UNREACHABLE"].includes(String(refused.error?.code))) return null;
  } catch {
    return null;
  }

  const resolved = await resolveRdpPort(args.projectPath, browser, {
    waitMs: target.extensionDocument ? 3_000 : 1_000,
    graceMs: target.extensionDocument ? 1_000 : 500,
  });

  if (!resolved) {
    const production = target.extensionDocument ? productionSessionCommand(args.projectPath, browser) : null;

    return production ? extensionPageUnreachable(schema.name, browser, production, target.label) : null;
  }

  const wantHtml = args.include?.includes("html") === true;

  try {
    const outcome = await rdpEvaluateInTab(resolved.port, {
      select: target.select,
      expression: protocolSnapshotExpression(wantHtml, args.maxBytes ?? 262144),
      timeoutMs: args.timeout ?? 10_000,
    });

    if (!outcome.ok) {
      const production =
        outcome.name === "TargetNotFound" && target.extensionDocument
          ? productionSessionCommand(args.projectPath, browser)
          : null;

      return production ? extensionPageUnreachable(schema.name, browser, production, target.label, "no-tab") : null;
    }

    return envelope({
      ok: true,
      command: schema.name,
      status: "ok",
      value: outcome.value,
      warnings: [
        `${url ?? target.label} is a page inside the extension, which Firefox lets no script be injected into, so this snapshot was read over the debugger protocol from the tab showing it.${ 
          consoleAsked
            ? " Console lines are not collected on this path; read them with extension_logs."
            : ""}`,
      ],
    });
  } catch {
    return null;
  }
}

type SnapshotArgs = ActArgs & { include?: string[]; maxBytes?: number; targetId?: string };

function snapshotRead(
  command: string,
  value: unknown,
  target: { targetId: string; url: string },
  transport: string,
  warnings: Array<string | null>,
): string {
  return envelope({
    ok: true,
    command,
    status: "ok",
    value: { ...(value && typeof value === "object" ? value : {}), target: { ...target, transport } },
    warnings,
  });
}

function snapshotFailed(message: string): string {
  return envelope({
    ok: false,
    command: schema.name,
    status: "snapshot-failed",
    error: { code: "E_EVAL", name: "SnapshotFailed", message },
    hint: "The target was found but the snapshot could not be read from it; it may have navigated or closed. Retry, or list what is open with listTargets: true.",
  });
}

async function snapshotByTargetId(
  args: SnapshotArgs,
  browser: string,
  targetId: string,
  warnings: Array<string | null>,
): Promise<string> {
  const expression = protocolSnapshotExpression(args.include?.includes("html") === true, args.maxBytes ?? 262144);

  if (isGeckoFamily(browser)) {
    const resolved = await resolveRdpPort(args.projectPath, browser);

    if (!resolved) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-session",
        error: { code: "E_NO_SESSION", name: "NoSession", message: `No active dev session with a Firefox debugger server (RDP) for ${browser}, so targetId has no browser to ask. ${RDP_PORT_MISSING_HINT}` },
      });
    }

    try {
      const tabs = await rdpListTabs(resolved.port);
      const tab = findGeckoTab(tabs, targetId);
      if (!tab) return targetNotFound(schema.name, targetId, tabs.map(geckoTabRef));

      const outcome = await rdpEvaluateInTab(resolved.port, {
        select: (live) => findGeckoTab(live, targetId),
        expression,
        timeoutMs: args.timeout ?? 10_000,
      });
      if (!outcome.ok) return snapshotFailed(outcome.message);

      return snapshotRead(schema.name, outcome.value, geckoTabRef(tab), "rdp", warnings);
    } catch (e) {
      return snapshotFailed(e instanceof Error ? e.message : String(e));
    }
  }

  const cdp = await cdpPortOrError(args.projectPath, browser, "targetId");
  if ("error" in cdp) return cdp.error;

  let targets: PageTarget[];

  try {
    targets = await listDocumentTargets(cdp.port);
  } catch (e) {
    return snapshotFailed(`Could not list page targets: ${e instanceof Error ? e.message : String(e)}`);
  }

  const target = targets.find((t) => t.targetId === targetId);
  if (!target) return targetNotFound(schema.name, targetId, targets.map((t) => ({ targetId: t.targetId, url: t.url })), { projectPath: args.projectPath, browser });

  const outcome = await evaluateOnExtensionPage(cdp.port, targetId, expression, args.timeout);
  if (!outcome.ok) return snapshotFailed(outcome.message);

  return snapshotRead(schema.name, outcome.value, { targetId, url: target.url }, "cdp", warnings);
}

async function cdpPortOrError(
  projectPath: string,
  browser: string,
  feature: string,
): Promise<{ port: number } | { error: string }> {
  if (!isChromiumFamily(browser)) {
    return {
      error: envelope({
        ok: false,
        command: schema.name,
        status: "unsupported-browser",
        error: {
          code: "E_UNSUPPORTED_BROWSER",
          name: "Unsupported",
          message: `${feature} reads the browser's CDP page targets, which ${browser} does not expose. Target the tab with \`url\` or \`tab\` instead, and discover tabs with listTabs: true (agent bridge, works on every browser).`,
        },
      }),
    };
  }

  const resolved = await resolveCdpPort(projectPath, browser);

  if (!resolved) {
    return {
      error: noSessionEnvelope({
        command: schema.name,
        projectPath,
        browser,
        name: "NoSession",
        need: `so ${feature} has no browser to ask`,
        dev: {
          message: `No active dev session / CDP port for ${browser}, so ${feature} has no browser to ask. Start extension_dev and extension_wait for ready. ${CDP_PORT_MISSING_HINT}`,
        },
      }),
    };
  }

  return { port: resolved.port };
}

export async function handler(
  args: ActArgs & {
    tab?: number;
    url?: string;
    tabUrl?: string;
    targetId?: string;
    listTargets?: boolean;
    listTabs?: boolean;
    include?: string[];
    maxBytes?: number;
    withConsole?: number | boolean;
  },
): Promise<string> {
  const withConsole =
    args.withConsole === true ? 50 : args.withConsole === false ? undefined : args.withConsole;

  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  if (args.listTargets) {
    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

    if (isGeckoFamily(browser)) {
      const resolved = await resolveRdpPort(args.projectPath, browser);

      if (!resolved) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-session",
          error: {
            code: "E_NO_SESSION",
            name: "NoSession",
            message: `No active dev session with a Firefox debugger server (RDP) for ${browser}, so listTargets has no browser to ask. Start extension_dev and extension_wait for ready. ${RDP_PORT_MISSING_HINT}`,
          },
        });
      }

      try {
        const tabs = await rdpListTabs(resolved.port);

        return envelope({
          ok: true,
          command: schema.name,
          status: "listed-targets",
          value: {
            browser,
            transport: "rdp",
            targets: tabs.map((t) => ({
              targetId: geckoTargetId(t),
              actor: String(t.actor ?? ""),
              type: "tab",
              url: String(t.url ?? ""),
              title: String(t.title ?? ""),
              ...(t.selected === true ? { selected: true } : {}),
            })),
          },
          warnings: [RDP_ACTOR_NOTE],
        });
      } catch (e) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "rdp-failed",
          error: {
            code: "E_RDP",
            name: "RdpError",
            message: `Could not list tab targets over RDP: ${e instanceof Error ? e.message : String(e)}`,
          },
          hint: "Confirm the session is ready (extension_wait), then retry. listTabs: true is the bridge alternative (rides the control channel, on unless the session was started with allowControl: false).",
        });
      }
    }

    const cdp = await cdpPortOrError(args.projectPath, browser, "listTargets");
    if ("error" in cdp) return cdp.error;

    try {
      const targets = await listPageTargets(cdp.port);

      return envelope({
        ok: true,
        command: schema.name,
        status: "listed-targets",
        value: { browser, targets },
        warnings: [TARGET_ID_NOTE],
      });
    } catch (e) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "cdp-failed",
        error: {
          code: "E_CDP",
          name: "CdpError",
          message: `Could not list page targets: ${e instanceof Error ? e.message : String(e)}`,
        },
        hint: "Confirm the session is ready (extension_wait), then retry. listTabs: true is the CDP-free alternative.",
      });
    }
  }

  if (args.listTabs) {
    return runActVerb(
      [
        "inspect",
        args.projectPath,
        "--list-tabs",
        "--browser",
        resolveSessionBrowser(args.projectPath, args.browser).browser,
        ...(args.timeout != null ? ["--timeout", String(args.timeout)] : []),
      ],
      args.projectPath,
      args.timeout,
      schema.name,
    );
  }

  const consoleNote = withConsole != null ? "Console lines are not collected when the page is read by targetId; read them with extension_logs." : null;

  if (args.targetId) {
    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

    return snapshotByTargetId(args, browser, args.targetId, [consoleNote]);
  }

  let targetUrl = args.url;
  let targetTab = args.tab;
  let resolvedTarget: Record<string, unknown> | null = null;
  let tabPickWarning: string | null = null;

  if (args.tabUrl) {
    if (args.tab != null || args.url) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          name: "BadRequest",
          message:
            "Pass ONE tab selector: `tabUrl` (URL substring, resolved against live targets), `url` (engine-side match), or `tab` (numeric chrome.tabs id), not several.",
        },
      });
    }

    const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

    if (!isChromiumFamily(browser)) {
      const listed = await listBridgeTabs(
        args.projectPath,
        browser,
        args.timeout,
      );
      if ("error" in listed) return listed.error;

      const matches = matchTabsByUrl(listed.tabs, args.tabUrl);

      if (matches.length === 0) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-matching-target",
          error: {
            code: "E_NO_MATCHING_TARGET",
            name: "NoMatchingTarget",
            message: `No open tab's url (or title) contains "${args.tabUrl}" (case-insensitive).`,
          },
          value: { availableTabs: listed.tabs },
          hint: "Pick one from availableTabs and retry with a `tabUrl` substring of its url, or open the page first (extension_open with `url`).",
        });
      }

      const sameTabs = pickTarget(
        matches,
        (t) => ({ targetId: String(t.tabId ?? ""), url: t.url }),
        (a, b) => (b.tabId ?? -1) - (a.tabId ?? -1),
      );

      if (sameTabs.kind !== "one" || (sameTabs.others.length > 0 && sameTabs.target.tabId == null)) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "ambiguous-target",
          error: {
            code: "E_AMBIGUOUS_TARGET",
            name: "AmbiguousTabUrl",
            message: `${matches.length} tabs match "${args.tabUrl}"; refusing to guess which tab you mean.`,
          },
          value: { matchingTabs: matches },
          hint: "Narrow `tabUrl` to a longer substring that matches exactly one url in matchingTabs, pass its numeric tabId as `tab`, or pass a targetId from listTargets: true as `targetId`.",
        });
      }

      const picked = sameTabs.target;
      resolvedTarget = { ...picked };
      if (picked.tabId != null) targetTab = picked.tabId;
      else targetUrl = picked.url;

      if (sameTabs.others.length > 0) {
        tabPickWarning = `${matches.length} open tabs show ${picked.url}; this read tab ${picked.tabId}, the most recently created one. The others: ${sameTabs.others.map((o) => o.tabId).join(", ")}. Pass \`tab\` to pick another.`;
      }
    } else {
      const cdp = await cdpPortOrError(args.projectPath, browser, "tabUrl");
      if ("error" in cdp) return cdp.error;

      let targets: Awaited<ReturnType<typeof listPageTargets>>;

      try {
        targets = await listPageTargets(cdp.port);
      } catch (e) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "cdp-failed",
          error: {
            code: "E_CDP",
            name: "CdpError",
            message: `Could not list page targets to resolve tabUrl: ${e instanceof Error ? e.message : String(e)}`,
          },
          hint: "Confirm the session is ready (extension_wait), then retry, or target with `url`/`tab` instead.",
        });
      }

      const matches = matchTargetsByUrl(targets, args.tabUrl);

      if (matches.length === 0) {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-matching-target",
          error: {
            code: "E_NO_MATCHING_TARGET",
            name: "NoMatchingTarget",
            message: `No open page target's url (or title) contains "${args.tabUrl}" (case-insensitive).`,
          },
          value: { availableTargets: targets },
          hint: `Pick one from availableTargets and retry with a \`tabUrl\` substring of its url, or open the page first (extension_open with \`url\`). ${TARGET_ID_NOTE}`,
        });
      }

      const pick = pickTarget(matches, (t) => ({ targetId: t.targetId, url: t.url }));

      if (pick.kind === "different") {
        return envelope({
          ok: false,
          command: schema.name,
          status: "ambiguous-target",
          error: {
            code: "E_AMBIGUOUS_TARGET",
            name: "AmbiguousTabUrl",
            message: `${matches.length} page targets that show different pages match "${args.tabUrl}"; refusing to guess which tab you mean.`,
          },
          value: { matchingTargets: matches },
          hint: `${AMBIGUOUS_TARGET_HINT} ${TARGET_ID_NOTE}`,
        });
      }

      if (pick.kind === "one" && pick.others.length > 0) {
        const ref = (t: PageTarget) => ({ targetId: t.targetId, url: t.url });

        return snapshotByTargetId(args, browser, pick.target.targetId, [
          identicalPickWarning(ref(pick.target), pick.others.map(ref), "chromium"),
          consoleNote,
        ]);
      }

      resolvedTarget = { ...matches[0] };
      targetUrl = matches[0].url;
    }
  }

  const cli = ["inspect", args.projectPath];
  if (targetTab != null) cli.push("--tab", String(targetTab));
  if (targetUrl) cli.push("--url", targetUrl);
  if (args.context) cli.push("--context", args.context);
  if (args.include?.length) cli.push("--include", args.include.join(","));
  if (args.maxBytes != null) cli.push("--max-bytes", String(args.maxBytes));
  if (withConsole != null) cli.push("--with-console", String(withConsole));

  cli.push("--browser", resolveSessionBrowser(args.projectPath, args.browser).browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));

  const sessionBrowser = resolveSessionBrowser(args.projectPath, args.browser).browser;
  const asked = await runActVerb(cli, args.projectPath, args.timeout, schema.name);
  const overProtocol = await snapshotExtensionPageOverProtocol(
    args,
    sessionBrowser,
    targetUrl ?? (typeof resolvedTarget?.url === "string" ? resolvedTarget.url : undefined),
    asked,
    withConsole != null,
  );
  const raw = overProtocol ?? asked;
  if (!resolvedTarget) return raw;

  try {
    const parsed = JSON.parse(raw);
    if (tabPickWarning) addWarning(parsed, tabPickWarning);

    patchValue(parsed, {
      resolvedTarget: { ...resolvedTarget, matchedBy: "tabUrl" },
    });

    const reported =
      typeof parsed?.value?.meta?.url === "string"
        ? parsed.value.meta.url
        : typeof parsed?.value?.url === "string"
          ? parsed.value.url
          : null;
    const resolvedUrl = typeof resolvedTarget.url === "string" ? resolvedTarget.url : null;

    if (reported && resolvedUrl && reported.replace(/#.*$/, "") !== resolvedUrl.replace(/#.*$/, "")) {
      addWarning(
        parsed,
        `The snapshot reports ${reported} while the target this server resolved was ${resolvedUrl}; the tab navigated between the two reads, and the values describe what the snapshot reports.`,
      );
    }

    return actFrameJson(parsed);
  } catch {
    return raw;
  }
}
