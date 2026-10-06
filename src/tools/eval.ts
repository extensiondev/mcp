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
import crypto from "node:crypto";
import fs from "node:fs";
import {
  RELAY_MARK,
  readRelayFrame,
  relayPollExpression,
  relaySafeExpression,
} from "../lib/relay-eval";
import {
  runActVerb,
  commonFlags,
  actFrameJson,
  addWarning,
  type ActArgs,
} from "../lib/act";
import { envelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";
import { evalTokenPresent } from "../lib/session-paths";
import {
  isChromiumFamily,
  isGeckoFamily,
  WEBKIT_FAMILY,
} from "../lib/browser-family";
import {
  readWebDriverSession,
  WebDriverClient,
  type WebDriverSessionInfo,
} from "../lib/webdriver";
import { manifestCandidates } from "../lib/project-manifest";
import {
  resolveCdpPort,
  resolveRdpPort,
  CDP_PORT_MISSING_HINT,
} from "../lib/cdp-port";
import { rdpEvaluateInTab, type RdpTab } from "../lib/rdp";
import { matchPatternCovers } from "../lib/match-patterns";
import {
  evaluateOnExtensionPage,
  readExtensionPageTargets,
  readExtensionWorkerTargets,
  wakeExtensionWorker,
  BACKGROUND_TARGET_TYPES,
} from "../lib/cdp-extension-page";
import { listPageTargets, matchTargetsByUrl } from "../lib/cdp-targets";
import {
  declaredSurfaces,
  resolveExtensionId,
  surfaceDocument,
  SURFACE_MANIFEST_KEYS,
} from "./open";
import {
  EXTENSION_PAGE_CONTEXTS,
  isExtensionUrl,
  surfaceForExtensionUrl,
} from "../lib/extension-surfaces";
import { executeScriptExpression } from "./inspect-gecko";

export const schema = {
  name: "extension_eval",
  description:
    "Evaluate an expression in a running extension context. Start the session with allowEval:true (extension_dev), which writes a 0600 session token; without that token every route of this tool, the debug port included, answers eval-disabled. Context defaults to 'background', except on a Chromium MV3 session (the default template) where it defaults to 'page', the active tab; pass context:'background' to evaluate in the service worker, which on Chromium goes over the debug port. Debug-port evaluates run with a user gesture, so gesture-gated APIs (permissions.request, sidePanel.open) can succeed here and still fail when the extension's own code calls them. For content and page, pass `url` to pick the tab, or omit both `url` and `tab` for the active tab; a numeric `tab` only disambiguates. Extension surfaces (popup, options, sidebar, devtools) and override pages (newtab, history, bookmarks) need no tab id but must already be open: open one with extension_open first, because a closed one returns an explicit error. On a Chromium MV3 session those pages, and context:'page' with a chrome-extension:// url, evaluate over CDP, the inspector path the extension page CSP does not govern; elsewhere they evaluate over the in-bundle relay. On Firefox a document whose content security policy forbids eval (the extension's own pages, or a site's) is evaluated over the debugger protocol instead, which takes one expression; a page inside the extension that is no declared surface (pages/*) is reached the same way by context:'page' and its moz-extension:// url once a tab shows it. Call extension_dom_snapshot with listTabs:true to enumerate {tabId, url, title}.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate in the target context",
      },
      context: {
        type: "string",
        enum: ["background", "popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks", "content", "page"],
        description: "Where to evaluate. Default background, except Chromium MV3 sessions default to page (the active tab).",
      },
      url: { type: "string", description: "content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`." },
      tab: { type: "number", description: "Numeric chrome.tabs id, only to disambiguate when several tabs match." },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath", "expression"],
  },
};

export function chromiumManifestVersion(
  projectPath: string,
  browser: string,
): 2 | 3 | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const version =
      manifest["chromium:manifest_version"] ?? manifest.manifest_version;
    if (version === 3) return 3;
    if (version === 2) return 2;
  }
  return null;
}

export function geckoManifestVersion(
  projectPath: string,
  browser: string,
): 2 | 3 | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const version =
      manifest["firefox:manifest_version"] ??
      manifest["gecko:manifest_version"] ??
      manifest.manifest_version;
    if (version === 3) return 3;
    if (version === 2) return 2;
  }
  return null;
}

export function resolveDefaultEvalContext(
  projectPath: string,
  browser: string,
): "background" | "page" {
  if (!isChromiumFamily(browser)) return "background";
  return chromiumManifestVersion(projectPath, browser) === 3
    ? "page"
    : "background";
}

export { EXTENSION_PAGE_CONTEXTS };

/* @invariant On Chromium every context the server can name is a CDP target:
   the extension's pages, its background (a service worker on MV3, a
   background page on MV2) and any web tab. Runtime.evaluate on the target
   is the inspector path, which neither the extension's CSP nor a site's
   Trusted Types policy governs, while the in-page string eval the relay and
   chrome.scripting use is refused by both. So on
   Chromium the background always goes over CDP, a page named by url goes
   over CDP, and the relay is kept for content (the isolated world only the
   extension has) and for the active tab when no url names it. */
export function wantsExtensionPageOverCdp(
  projectPath: string,
  browser: string,
  context: string | undefined,
  url: string | undefined,
): boolean {
  if (!isChromiumFamily(browser) || !context) return false;
  if (context === "background") return true;
  if (context === "page") return typeof url === "string" && url.length > 0;
  return (
    EXTENSION_PAGE_CONTEXTS.includes(context) &&
    chromiumManifestVersion(projectPath, browser) === 3
  );
}

function targetsUnreadable(why: string): string {
  return envelope({
    ok: false,
    command: schema.name,
    status: "targets-unreadable",
    error: {
      code: "E_CDP",
      name: "TargetsUnreadable",
      message: `Could not list the session's CDP targets: ${why}. Whether the page or worker is open is unknown.`,
    },
    hint: "The session's debug port did not answer. extension_doctor says whether the browser is still up; if it is, retry.",
  });
}

async function evaluateOnChromiumExtensionPage(
  args: ActArgs & { expression: string },
  browser: string,
  context: string,
  resolved: { port: number },
): Promise<string> {
  let wanted: string;
  if (context === "background") {
    const extensionId = await resolveExtensionId(args.projectPath, browser);
    if (!extensionId) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-extension-id",
        error: {
          code: "E_NO_EXTENSION_ID",
          name: "NoExtensionId",
          message:
            "Could not resolve the extension id from the live session's CDP targets.",
        },
        hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
      });
    }
    const workersRead = await readExtensionWorkerTargets(resolved.port, extensionId);
    if ("unreadable" in workersRead) return targetsUnreadable(workersRead.unreadable);
    let workers = workersRead.targets.filter((t) => BACKGROUND_TARGET_TYPES.has(t.type));
    const wakeWarnings: string[] = [];
    if (workers.length === 0) {
      const wake = await wakeExtensionWorker(resolved.port, extensionId);
      const woken = wake.woken ? wake.targets.filter((t) => BACKGROUND_TARGET_TYPES.has(t.type)) : [];
      if (wake.woken && woken.length > 0) {
        workers = woken;
        wakeWarnings.push(
          "No running background worker was listed, so it was started through ServiceWorker.startWorker before evaluating. Chrome stops an idle MV3 service worker after about 30 s without events, but a worker that never started looks the same here, so this does not say it idled; any in-memory state from an earlier run of it is gone unless it was persisted.",
        );
      } else {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-target",
          error: {
            code: "E_NO_TARGET",
            name: "NoTarget",
            message: `No running background for chrome-extension://${extensionId}/: Chrome stops an idle MV3 service worker and lists no target for it, and starting it through ServiceWorker.startWorker did not bring one back: ${wake.woken ? "only dedicated workers were listed, which are not the background" : wake.reason}.`,
          },
          hint: "Check the extension declares a background (extension_manifest_validate), then wake it with an event it listens to (extension_reload, open a surface with extension_open, navigate a matching tab) and retry. extension_logs (context: ['background']) holds what it wrote before it idled.",
        });
      }
    }
    const target = workers[0];
    const outcome = await evaluateOnExtensionPage(
      resolved.port,
      target.targetId,
      args.expression,
      args.timeout,
    );
    if (!outcome.ok) {
      return envelope({
        ok: false,
        command: schema.name,
        status: outcome.thrown ? "eval-failed" : outcome.timedOut ? "eval-timeout" : "cdp-failed",
        error: {
          code: outcome.thrown ? "E_EVAL" : "E_CDP",
          name: outcome.thrown ? "EvalError" : "CdpError",
          message: outcome.message,
        },
        hint: outcome.thrown
          ? `The expression threw inside the ${target.type} at ${target.url}; it ran over CDP with the extension APIs available and a returned promise awaited.`
          : "The session's debug port refused the call or the worker went away mid-call. extension_doctor names which.",
      });
    }
    return envelope({
      ok: true,
      command: schema.name,
      status: "evaluated",
      value: outcome.value,
      warnings: [
        outcome.note ?? null,
        ...wakeWarnings,
        ...(workers.length > 1
          ? [
              `${workers.length} background targets match the extension; evaluated in ${target.type} ${target.targetId}.`,
            ]
          : []),
      ],
      hint: `Evaluated over CDP in the extension's ${target.type} (${target.url}), the inspector path the extension CSP does not govern; a returned promise is awaited.`,
    });
  }
  if (context === "page" && !isExtensionUrl(args.url)) {
    const url = args.url as string;
    const matches = matchTargetsByUrl(await listPageTargets(resolved.port), url);
    if (matches.length === 0) return RELAY_INSTEAD;
    return evaluateOnWebTarget(args, matches, url, browser);
  }
  if (context === "page") {
    wanted = args.url as string;
  } else {
    const doc = surfaceDocument(args.projectPath, browser, context);
    if (!doc) {
      const key = SURFACE_MANIFEST_KEYS[context] ?? context;
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-surface",
        error: {
          code: "E_NO_SURFACE_DOCUMENT",
          name: "NoSurfaceDocument",
          message: `This extension declares no ${context}: nothing in its manifest sets ${key}, so there is no ${context} page to evaluate in.`,
        },
        hint: `To add one, set ${key} in the manifest and rebuild.`,
      });
    }
    const extensionId = await resolveExtensionId(args.projectPath, browser);
    if (!extensionId) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-extension-id",
        error: {
          code: "E_NO_EXTENSION_ID",
          name: "NoExtensionId",
          message:
            "Could not resolve the extension id from the live session's CDP targets.",
        },
        hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
      });
    }
    wanted = `chrome-extension://${extensionId}/${doc}`;
  }
  const pagesRead = await readExtensionPageTargets(resolved.port, wanted);
  if ("unreadable" in pagesRead) return targetsUnreadable(pagesRead.unreadable);
  const targets = pagesRead.targets.filter((t) => !isBrowserErrorPage(t.url));
  if (targets.length === 0) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-target",
      error: {
        code: "E_NO_TARGET",
        name: "NoTarget",
        message: `No open page at ${wanted}, so there is nothing to evaluate in. An extension page evaluates over CDP on its own target, which exists only while the page is open.`,
      },
      hint:
        context === "page"
          ? "Open it first with extension_open (url: this address), then retry. extension_dom_snapshot with listTargets: true lists what is open."
          : `Open it first with extension_open surface: "${context}", then retry. extension_dom_snapshot with listTargets: true lists what is open.`,
    });
  }
  const target = targets[0];
  const outcome = await evaluateOnExtensionPage(
    resolved.port,
    target.targetId,
    args.expression,
    args.timeout,
  );
  const others = targets.slice(1);
  const warnings = others.length
    ? [
        `${targets.length} open pages match ${wanted}; evaluated in target ${target.targetId} (${target.url}). The others: ${others.map((t) => t.targetId).join(", ")}. Close the copies you do not mean, or navigate away from them.`,
      ]
    : [];
  if (!outcome.ok) {
    return envelope({
      ok: false,
      command: schema.name,
      status: outcome.thrown ? "eval-failed" : outcome.timedOut ? "eval-timeout" : "cdp-failed",
      error: {
        code: outcome.thrown ? "E_EVAL" : "E_CDP",
        name: outcome.thrown ? "EvalError" : "CdpError",
        message: outcome.message,
      },
      warnings,
      hint: outcome.thrown
        ? `The expression threw inside ${target.url}. It ran over CDP in the page's main world with extension APIs available; a promise is awaited, so an async expression can be returned directly.`
        : "The session's debug port refused the call or the target went away. extension_doctor names which; a session that ended needs extension_dev again.",
    });
  }
  return envelope({
    ok: true,
    command: schema.name,
    status: "evaluated",
    value: outcome.value,
    warnings: [...warnings, outcome.note ?? null],
    hint: `Evaluated over CDP in ${target.url} (target ${target.targetId}), the inspector path the extension page CSP does not govern. The result is serialized by value, so return plain data rather than DOM nodes; a promise is awaited before returning.`,
  });
}

/* @invariant On Safari the extension's own bridge is the eval channel, the
 * same one every other engine uses: content and background run through the
 * dev session's executor. A safaridriver session, when a dev session has
 * recorded one, adds only the page's main world, so it is used for exactly
 * the explicit "page" context and nothing else is diverted from the bridge.
 */
async function evaluateOnWebKitPage(
  args: ActArgs & { expression: string },
  browser: string,
  info: WebDriverSessionInfo,
): Promise<string> {
  const client = new WebDriverClient(info);
  if (args.url) {
    const current = await client.currentUrl().catch(() => null);
    if (!current || !current.startsWith(args.url)) {
      await client.navigate(args.url);
    }
  }
  try {
    const value = await client.execute(`return (${args.expression});`);
    return envelope({
      ok: true,
      command: schema.name,
      status: "evaluated",
      value: {
        context: "page",
        browser,
        url: await client.currentUrl().catch(() => null),
        result: value,
      },
      hint: "Evaluated in the Safari automation window's main world over the dev session's WebDriver connection.",
    });
  } catch (error) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: {
        code: "E_EVAL",
        name: "EvalError",
        message: error instanceof Error ? error.message : String(error),
      },
      hint: "The expression threw, or the automation window is gone. extension_doctor names which; a session that ended needs extension_dev again.",
    });
  }
}

const RELAY_INSTEAD = "__relay_instead__";

export function isBrowserErrorPage(url: string): boolean {
  return /^(chrome|edge)-error:\/\//.test(url);
}

/* @invariant A web tab named by url evaluates on its own CDP target, so a
   site's Trusted Types policy (YouTube, Gmail, most Google properties) or
   CSP never sees the expression; the in-page string eval the relay performs
   is exactly what those policies refuse. */
async function evaluateOnWebTarget(
  args: ActArgs & { expression: string },
  matches: Array<{ targetId: string; url: string; title: string }>,
  url: string,
  browser: string,
): Promise<string> {
  const resolved = await resolveCdpPort(args.projectPath, browser);
  if (!resolved) return RELAY_INSTEAD;
  const live = matches.filter((t) => !isBrowserErrorPage(t.url));
  if (live.length === 0) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-target",
      error: {
        code: "E_NO_TARGET",
        name: "NoTarget",
        message: `The tab matching ${url} shows the browser's own error page (${matches[0].title || matches[0].url}), so there is no document to evaluate in.`,
      },
      hint: "The page was blocked or failed to load; open it again with extension_open and read the browser's reason in the tab title.",
    });
  }
  const target = live[0];
  const outcome = await evaluateOnExtensionPage(resolved.port, target.targetId, args.expression, args.timeout);
  if (!outcome.ok) {
    return envelope({
      ok: false,
      command: schema.name,
      status: outcome.thrown ? "eval-failed" : outcome.timedOut ? "eval-timeout" : "cdp-failed",
      error: {
        code: outcome.thrown ? "E_EVAL" : "E_CDP",
        name: outcome.thrown ? "EvalError" : "CdpError",
        message: outcome.message,
      },
      hint: outcome.thrown
        ? `The expression threw inside ${target.url}; it ran over CDP in the page's main world.`
        : "The session's debug port refused the call or the tab went away. extension_doctor names which.",
    });
  }
  return envelope({
    ok: true,
    command: schema.name,
    status: "evaluated",
    value: outcome.value,
    warnings: [
      ...(live.length > 1
        ? [
            `${live.length} tabs match ${url}; evaluated in ${target.url} (target ${target.targetId}). Narrow the url to pick another.`,
          ]
        : []),
      outcome.note ?? null,
    ],
    hint: `Evaluated over CDP in ${target.url} (target ${target.targetId}), the page's main world through the inspector, which the site's CSP and Trusted Types do not govern. Pass context: "content" for the extension's isolated world instead.`,
  });
}

const TRUSTED_TYPES_REFUSAL = /Trusted Type/i;

const RELAY_POLL_MS = 300;
const RELAY_DEFAULT_BUDGET_MS = 30_000;

function tryParseFrame(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function evaluateThroughRelay(
  args: ActArgs & { expression: string },
  browser: string,
  context: string,
): Promise<string> {
  const token = crypto.randomUUID();
  const budgetMs = args.timeout ?? RELAY_DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const run = (expression: string): Promise<string> =>
    runActVerb(
      [
        "eval",
        ...commonFlags({ ...args, context, browser }),
        "--",
        expression,
        args.projectPath,
      ],
      args.projectPath,
      args.timeout,
      schema.name,
    );
  let raw = await run(relaySafeExpression(args.expression, token));
  let parsed = tryParseFrame(raw);
  if (isGeckoFamily(browser) && cspRefusedFrame(parsed)) {
    return evaluatePastSurfaceCsp(args, context, run);
  }
  if (!parsed || parsed.ok !== true) return raw;
  let frame = readRelayFrame(parsed.value);
  if (!frame) return raw;
  let polls = 0;
  while (!frame.done) {
    if (Date.now() >= deadline) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "eval-pending",
        error: {
          code: "E_WAIT_TIMEOUT",
          name: "EvalPending",
          message: `The expression returned a promise that had not settled after ${budgetMs} ms; it is still running in the ${context} page.`,
        },
        value: { context, token, polls },
        hint: `Its outcome lands in globalThis.${RELAY_MARK}[${JSON.stringify(token)}] inside the ${context} page when it settles ({done, ok, value}): read it with extension_eval in the same context, or pass a larger timeout to wait here.`,
      });
    }
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
    polls += 1;
    raw = await run(relayPollExpression(token));
    parsed = tryParseFrame(raw);
    if (!parsed || parsed.ok !== true) return raw;
    const next = readRelayFrame(parsed.value);
    if (!next) return raw;
    frame = next;
  }
  if (frame.ok === false) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: {
        code: "E_EVAL",
        name: frame.name || "EvalError",
        message: frame.message || "the expression rejected",
      },
      hint: `The expression threw, or the promise it returned rejected, inside the ${context} page.`,
    });
  }
  parsed.value = frame.value === undefined ? null : frame.value;
  if (polls > 0) {
    parsed.hint =
      `The expression returned a promise; the ${context} page settled it and this call polled ${polls} time${polls === 1 ? "" : "s"} for the result. ` +
      (typeof parsed.hint === "string" ? parsed.hint : "");
  }
  return actFrameJson(parsed);
}

/* @invariant The engine blames the expression for the extension's own CSP:
   "call to eval() blocked by CSP" comes back as E_EVAL with "check the
   expression itself", while any expression fails the same way in a page whose
   content_security_policy forbids eval (every MV3 extension page with an
   explicit policy, and MV3 backgrounds). The hint names the policy and the
   paths that do not go through eval. From Extension.js
   4.1.31 the engine names the refusal itself as E_CSP_BLOCKS_EVAL, in every
   context, so both spellings are read here: a check for E_EVAL alone goes
   dead on the engine this server pins. */
const CSP_EVAL_REFUSAL = /blocked by CSP|call to eval|unsafe-eval|Content Security Policy/i;

function cspRefusedFrame(parsed: Record<string, any> | null): boolean {
  if (!parsed || parsed.ok !== false) return false;
  const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
  if (code === "E_CSP_BLOCKS_EVAL") return true;
  return code === "E_EVAL" && CSP_EVAL_REFUSAL.test(String(parsed.error?.message ?? ""));
}

function cspRefusalHint(context: string | undefined): string {
  if (context === "page") {
    return (
      "This page's own Content-Security-Policy forbids eval, so the in-page executor cannot run any expression in it; this is the site's policy, not a fault in the expression. " +
      "Pass url so the tab is evaluated through the browser's debugger, which the policy does not govern (CDP on Chromium, the debugger protocol on Firefox), or read the page with extension_dom_snapshot or extension_inspect."
    );
  }
  if (context === "content") {
    return (
      "The extension's content_security_policy forbids eval in its content-script world on this engine, so no string runs there; this is the extension's policy, not a fault in the expression. " +
      'Evaluate the page itself with context: "page" and a url, or read the DOM the content script sees with extension_dom_snapshot or extension_inspect.'
    );
  }
  return (
    `The extension's content_security_policy (or the MV3 default) forbids eval in its own ${context ?? "background"} context, so the in-page executor cannot run any expression there; this is the extension's policy, not a fault in the expression. ` +
    "Read the page instead with extension_dom_snapshot or extension_inspect, evaluate a web page with context: \"page\" and a url, or read the extension's console with extension_logs. On a Chromium MV3 session the extension's own pages evaluate over CDP, which the page policy does not govern. " +
    "On Firefox, Extension.js 4.1.31 and later evaluate them over the debugger protocol instead: if this session runs an older engine, upgrade the project's extension dependency and restart it."
  );
}

function explainCspRefusal(raw: string, context: string | undefined): string | null {
  const parsed = tryParseFrame(raw);
  if (!parsed || !cspRefusedFrame(parsed)) return null;
  parsed.error.name = "CspBlocksEval";
  parsed.hint = cspRefusalHint(context);
  if (typeof parsed.error.hint === "string") delete parsed.error.hint;
  return actFrameJson(parsed);
}

/* @invariant MV2 Gecko has no scripting API, so the engine refuses a page or
   content eval with "chrome.scripting is not available ... use context
   background", which cannot read the tab. tabs.executeScript can: the same
   background-side wrapper extension_inspect already uses runs the expression
   in the tab's content world and hands the completion value back. An expression that parses as one expression is wrapped so a
   throw comes back as data; a statement list runs as the script's completion
   value, the way executeScript defines it. */
const NO_SCRIPTING_API = /scripting is not available/i;

/* @invariant The same wrapper is the answer when the PAGE refuses: a site
   whose CSP forbids eval (YouTube) makes the in-page string executor fail
   with "call to eval() blocked by CSP" on Gecko, while tabs.executeScript
   injects as the extension and the page policy does not govern it. Only an MV2 build has tabs.executeScript; an MV3 Gecko build
   keeps the policy explanation, since protocol-level eval there is the engine's own concern. */
function pageEvalRefusedByCsp(parsed: Record<string, any>): boolean {
  return cspRefusedFrame(parsed);
}

function isSingleExpression(source: string): boolean {
  try {
    new Function(`return (${source}\n)`);
    return true;
  } catch {
    return false;
  }
}

/* @invariant The debugger protocol takes the expression as source inside a
   wrapper, never through eval, because eval is exactly what the document's
   policy refuses. A statement list has no value without eval's completion
   semantics, so it is refused here by name rather than sent on to fail as
   "SyntaxError: expected expression" under a control-channel code (measured
   on Extension.js 4.1.31, Firefox 159). */
function notOneExpression(): string {
  return envelope({
    ok: false,
    command: schema.name,
    status: "bad-request",
    error: {
      code: "E_BAD_REQUEST",
      name: "NotOneExpression",
      message:
        "This document's content security policy forbids eval, so Firefox evaluates it over the debugger protocol, which takes one expression, and this input is a statement list.",
    },
    hint: "Pass one expression. Wrap statements in a function that returns the value, for example (() => { const a = 20; return a + 1; })().",
  });
}

/* @invariant The relay wrapper settles a promise inside the page, and it
   reaches the expression through (0, eval). Under a policy that forbids
   eval that inner call is what throws, whoever evaluates the wrapper: the
   engine's protocol route ran the
   wrapper past the policy and the wrapper then refused itself, so popup and
   options still answered "blocked by CSP" on an engine that could read them
  . The bare expression has no
   inner eval: the bridge refuses it, the engine takes it over the protocol,
   awaits a promise there and hands the value back, so the wrapper is not
   needed on this path at all. */
async function evaluatePastSurfaceCsp(
  args: ActArgs & { expression: string },
  context: string,
  run: (expression: string) => Promise<string>,
): Promise<string> {
  if (!isSingleExpression(args.expression)) return notOneExpression();
  const direct = await run(args.expression);
  const frame = tryParseFrame(direct);
  if (!frame) return direct;
  if (cspRefusedFrame(frame)) return explainCspRefusal(direct, context) ?? direct;
  if (frame.ok === true && frame.value === undefined) {
    frame.value = null;
    return actFrameJson(frame);
  }
  return direct;
}

const sameDocumentUrl = (a: unknown, b: string): boolean =>
  String(a ?? "").replace(/[?#].*$/, "") === b.replace(/[?#].*$/, "");

function tabByUrl(tabs: RdpTab[], url: string, seen?: { matched: number }): RdpTab | undefined {
  const exact = tabs.filter((tab) => sameDocumentUrl(tab.url, url));
  const covered = exact.length
    ? exact
    : tabs.filter((tab) => matchPatternCovers(url, String(tab.url ?? "")));
  const candidates = covered.length
    ? covered
    : tabs.filter((tab) => String(tab.url ?? "").includes(url));
  if (seen) seen.matched = candidates.length;
  return candidates.find((tab) => tab.selected === true) ?? candidates[0];
}

/* @invariant On Gecko a tab has one door the document's policy does not
   govern: its console actor over the debugger protocol, the same server the
   session already publishes as rdpPort. It reaches what no injection can: a
   page inside the extension that the manifest declares as no surface
   (pages/*), which has no relay to ask and refuses executeScript whatever
   the host permissions, and a web page whose own policy
   forbids eval on an MV3 build, which has no tabs.executeScript to fall back
   on. Null means the protocol could not be reached, so the
   caller keeps the answer it already had. */
async function evaluateInGeckoTab(
  args: ActArgs & { expression: string },
  browser: string,
  select: (tabs: RdpTab[]) => RdpTab | null | undefined,
  missing: string,
  seen?: { matched: number },
): Promise<string | null> {
  const resolved = await resolveRdpPort(args.projectPath, browser, {
    waitMs: 3_000,
    graceMs: 1_000,
  });
  /* @invariant A DEBUGGER PORT THAT DID NOT ANSWER IS SAID AS SUCH. A port
     the session never published falls through to the relay's own answer; a
     published port whose call threw used to return null too, and the caller
     then said the url "matches none of the surface documents". */
  if (!resolved) return null;
  let outcome: Awaited<ReturnType<typeof rdpEvaluateInTab>>;
  try {
    outcome = await rdpEvaluateInTab(resolved.port, {
      select,
      expression: args.expression,
      timeoutMs: args.timeout ?? 10_000,
    });
  } catch (err) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "rdp-failed",
      error: {
        code: "E_RDP",
        name: "RdpFailed",
        message: `The ${browser} remote-debugging port ${resolved.port} did not answer: ${err instanceof Error ? err.message : String(err)}. The tab's documents were not read.`,
      },
      hint: "extension_doctor says whether the browser is still up; if it is, retry.",
    });
  }
  if (outcome.ok) {
    /* @invariant THE ANSWER NAMES THE TAB IT RAN IN, and says when several
       tabs matched the url and one was picked. */
    return envelope({
      ok: true,
      command: schema.name,
      status: "ok",
      value: outcome.value === undefined ? null : outcome.value,
      warnings: [
        `Evaluated in the tab showing ${outcome.tab.url || "an unknown url"}${outcome.tab.title ? ` ("${outcome.tab.title}")` : ""}.`,
        seen && seen.matched > 1
          ? `${seen.matched} open tabs matched the url; the selected one (or the first) was used. Narrow the url to pick another.`
          : null,
      ],
    });
  }
  if (outcome.name === "TargetNotFound") {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-matching-target",
      error: { code: "E_NO_MATCHING_TARGET", name: "NoMatchingTarget", message: missing },
      hint: "Open the page first with extension_open and its url, then retry; extension_dom_snapshot with listTabs: true lists what is open.",
    });
  }
  if (outcome.name === "Timeout") {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-pending",
      error: { code: "E_WAIT_TIMEOUT", name: "EvalPending", message: outcome.message },
      hint: "The expression returned a promise that is still pending; pass a larger timeout to wait for it.",
    });
  }
  /* @invariant THE HINT FOLLOWS WHAT FAILED. Unsupported means nothing ran
     and EvalLost means the document went away mid-call; only EvalError is
     the expression's own throw. */
  const lost = outcome.name === "EvalLost";
  const unsupported = outcome.name === "Unsupported";
  return envelope({
    ok: false,
    command: schema.name,
    status: lost ? "eval-lost" : unsupported ? "eval-unsupported" : "eval-failed",
    error: { code: "E_EVAL", name: outcome.name, message: outcome.message },
    hint: lost
      ? "The document navigated or closed before the expression answered, so it may have run in part; read the page's state before repeating it."
      : unsupported
        ? "The debugger protocol could not evaluate in that tab, so the expression never ran. extension_dom_snapshot reads the page without eval."
        : "The expression threw inside the document. It ran over the debugger protocol, which the document's content security policy does not govern, so this is the expression's own error.",
  });
}

/* @invariant The engine's protocol route embeds the expression as source,
   so a statement list sent to a policy-locked Gecko background comes back as
   "SyntaxError: expected expression" under the name Unavailable, which act
   then dresses as a control-channel failure. That name with that message is
   the route's own signature: an eval that is allowed reports a syntax error
   as the expression's, under E_EVAL. */
function backgroundRouteRefusedStatements(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
  raw: string,
): boolean {
  if (!isGeckoFamily(browser) || (context ?? "background") !== "background") return false;
  const failed = tryParseFrame(raw);
  if (!failed || failed.ok !== false) return false;
  if (failed.error?.name !== "Unavailable") return false;
  if (!/SyntaxError/.test(String(failed.error?.message ?? ""))) return false;
  return !isSingleExpression(args.expression);
}

async function evaluatePagePastSiteCsp(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
  raw: string,
): Promise<string | null> {
  if (context !== "page" || !isGeckoFamily(browser)) return null;
  if (!cspRefusedFrame(tryParseFrame(raw))) return null;
  if (!args.url && args.tab != null) return null;
  if (!isSingleExpression(args.expression)) return notOneExpression();
  const url = args.url;
  const seen = { matched: 0 };
  return evaluateInGeckoTab(
    args,
    browser,
    url
      ? (tabs) => tabByUrl(tabs, url, seen)
      : (tabs) => tabs.find((tab) => tab.selected === true),
    url ? `No open tab matches url: ${url}` : "No tab is selected in the dev browser.",
    seen,
  );
}

async function evaluateThroughExecuteScript(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
  raw: string,
): Promise<string | null> {
  if (context !== "page" && context !== "content") return null;
  if (isChromiumFamily(browser)) return null;
  const parsed = tryParseFrame(raw);
  if (!parsed || parsed.ok !== false) return null;
  const noScriptingApi = NO_SCRIPTING_API.test(String(parsed.error?.message ?? ""));
  const cspRefused =
    !noScriptingApi &&
    pageEvalRefusedByCsp(parsed) &&
    geckoManifestVersion(args.projectPath, browser) === 2;
  if (!noScriptingApi && !cspRefused) return null;
  const why = cspRefused
    ? "the page's content security policy refused the in-page eval"
    : `${browser} MV2 has no scripting API`;
  const code = isSingleExpression(args.expression)
    ? `(function () { try { return { __extensionDevExec: 1, ok: true, value: (${args.expression}\n) }; } catch (e) { return { __extensionDevExec: 1, ok: false, name: (e && e.name) || "EvalError", message: (e && e.message) || String(e) }; } })()`
    : args.expression;
  const wrapped = await runActVerb(
    [
      "eval",
      ...commonFlags({ ...args, context: "background", url: undefined, tab: undefined, browser }),
      "--",
      executeScriptExpression(args.url, code, typeof args.tab === "number" ? args.tab : undefined),
      args.projectPath,
    ],
    args.projectPath,
    args.timeout,
    schema.name,
  );
  const frame = tryParseFrame(wrapped);
  if (!frame || frame.ok !== true) return wrapped ?? raw;
  const value = frame.value;
  if (value && typeof value === "object" && typeof value.error === "string") {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: { code: "E_EVAL", name: "EvalError", message: value.error },
      hint: `Because ${why}, the expression went through tabs.executeScript from the background and that call failed. The tab must be a web page the extension holds host permissions for; extension pages cannot be injected into.`,
    });
  }
  const first = Array.isArray(value?.frames) ? value.frames[0] : undefined;
  const result =
    first && typeof first === "object" && first.__extensionDevExec === 1
      ? first
      : { ok: true, value: first === undefined ? null : first };
  if (result.ok === false) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: {
        code: "E_EVAL",
        name: result.name || "EvalError",
        message: result.message || "the expression threw",
      },
      hint: "The expression threw inside the tab (run through tabs.executeScript in the content world).",
    });
  }
  return envelope({
    ok: true,
    command: schema.name,
    status: "evaluated",
    value: result.value === undefined ? null : result.value,
    warnings: [
      `Because ${why}, this ran through tabs.executeScript from the background${
        typeof args.tab === "number" ? ` in tab ${args.tab}` : args.url ? ` in the first tab whose url contains ${JSON.stringify(args.url)}` : " in the active tab"
      }: the content script world of the tab, not the page's MAIN world, so globals the page defines are not visible${context === "page" ? ' even though context: "page" was asked' : ""}. An empty string or null here is the content world's reading at call time; if the element renders late, wait and retry.`,
    ],
    hint: "Pass url to pick the tab; the extension needs host permissions for it.",
  });
}

export async function handler(
  args: ActArgs & { expression: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  if (WEBKIT_FAMILY.has(browser) && args.context === "page") {
    const info = readWebDriverSession(args.projectPath, browser);
    if (info) return evaluateOnWebKitPage(args, browser, info);
  }
  const defaulted =
    !args.context &&
    resolveDefaultEvalContext(args.projectPath, browser) === "page";
  const context = defaulted ? "page" : args.context;
  if (wantsExtensionPageOverCdp(args.projectPath, browser, context, args.url)) {
    if (!evalTokenPresent(args.projectPath, browser)) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "eval-disabled",
        error: {
          code: "E_EVAL_DISABLED",
          name: "EvalDisabled",
          message:
            "eval is disabled for this session: it was started without allowEval: true, so no session token exists, and this tool evaluates nothing without one, over the debug port or the relay.",
        },
        hint: "Call extension_dev again with allowEval: true and replace: true (it stops this session first), then extension_eval again. Reads that need no eval still work: extension_dom_snapshot, extension_inspect, extension_logs, extension_assert.",
      });
    }
    const resolved = await resolveCdpPort(args.projectPath, browser);
    if (resolved) {
      const overCdp = await evaluateOnChromiumExtensionPage(
        args,
        browser,
        context as string,
        resolved,
      );
      if (overCdp !== RELAY_INSTEAD) return overCdp;
    }
  }
  /* @invariant On an engine with no CDP, a page inside the extension has one
     door: the surface relay of the context that document belongs to. The
     engine's page path answers "chrome.scripting is not available ... use
     context background" for a moz-extension:// url, Chromium vocabulary on
     Gecko pointing at a context that cannot read the page;
     the url is mapped to its surface here and the relay is asked instead. */
  if (context === "page" && isExtensionUrl(args.url)) {
    const surface = surfaceForExtensionUrl(
      args.projectPath,
      browser,
      args.url as string,
    );
    if (surface) {
      const raw = await evaluateThroughRelay(
        { ...args, url: undefined, tab: undefined },
        browser,
        surface.context,
      );
      const parsed = tryParseFrame(raw);
      if (parsed) {
        addWarning(
          parsed,
          `${args.url} is the extension's own ${surface.context} document (${surface.document}), which script injection cannot reach on any engine, so this evaluated through the ${surface.context} surface relay. Pass context: "${surface.context}" directly next time.`,
        );
        return actFrameJson(parsed);
      }
      return raw;
    }
    if (isGeckoFamily(browser)) {
      if (!isSingleExpression(args.expression)) return notOneExpression();
      const url = args.url as string;
      const overProtocol = await evaluateInGeckoTab(
        args,
        browser,
        (tabs) => tabs.find((tab) => sameDocumentUrl(tab.url, url)),
        `No open tab shows ${url}.`,
      );
      if (overProtocol !== null) return overProtocol;
    }
    const declared = declaredSurfaces(args.projectPath, browser) ?? [];
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-surface",
      error: {
        code: "E_NO_SURFACE_DOCUMENT",
        name: "NoSurfaceDocument",
        message: `${args.url} is a page inside the extension, which script injection cannot reach, and it matches none of the surface documents the manifest declares${declared.length ? ` (${declared.join(", ")})` : ""}.`,
      },
      hint: declared.length
        ? `Evaluate in a declared surface with context: "${declared[0]}" (open it first with extension_open), or read a web page by url.`
        : "Declare the page as a surface in the manifest (action.default_popup, options_ui.page, sidebar_action.default_panel or chrome_url_overrides) and rebuild.",
    });
  }
  if (context && EXTENSION_PAGE_CONTEXTS.includes(context)) {
    return evaluateThroughRelay(args, browser, context);
  }
  /* @invariant Options before "--", positionals after: the engine's commander
     parser reads a dash-leading expression as an unknown option unless the
     separator precedes it, and treats everything after "--" as operands. */
  const raw = await runActVerb(
    [
      "eval",
      ...commonFlags({ ...args, context, browser }),
      "--",
      args.expression,
      args.projectPath,
    ],
    args.projectPath,
    args.timeout,
    schema.name,
  );

  const mv2Fallback = await evaluateThroughExecuteScript(args, browser, context, raw);
  if (mv2Fallback !== null) return mv2Fallback;
  const pastSiteCsp = await evaluatePagePastSiteCsp(args, browser, context, raw);
  if (pastSiteCsp !== null) return pastSiteCsp;
  if (backgroundRouteRefusedStatements(args, browser, context, raw)) {
    return notOneExpression();
  }
  const cspRefusal = explainCspRefusal(raw, context);
  if (cspRefusal !== null) return cspRefusal;
  const trustedTypes = tryParseFrame(raw);
  if (
    trustedTypes?.ok === false &&
    TRUSTED_TYPES_REFUSAL.test(String(trustedTypes.error?.message ?? ""))
  ) {
    trustedTypes.hint =
      "This site enforces Trusted Types, which refuse a string evaluated inside the page. Pass url so the tab is evaluated over CDP (the inspector path the policy does not govern), or use context: \"content\" for a DOM read from the extension's isolated world.";
    return actFrameJson(trustedTypes);
  }
  if (args.context === "content") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.ok === true && (parsed.value === null || parsed.value === undefined)) {
        addWarning(
          parsed,
          "On Extension.js >= 4.0.14 a failed injection errors explicitly, so this null is the expression's real result. On OLDER engines (bug 61) it could mean the injection never ran; if this result looks wrong, check the engine version with extension_doctor, or verify with extension_logs or context:'page'.",
        );
        return actFrameJson(parsed);
      }
    } catch {
      // non-JSON payload; pass through untouched
    }
  }
  if (defaulted) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        /* @invariant THE PAGE'S VALUE IS NEVER EDITED: the default is said in
           a warning, not written into what the expression returned. */
        addWarning(
          parsed,
          'No context given: defaulted to "page" (the active tab). Pass context: "background" to evaluate in the service worker, which this tool reaches over the debug port.',
        );
        const code =
          typeof parsed.error?.code === "string" ? parsed.error.code : "";
        /* @invariant The code arm is the right one to read and still is not the
           one that fires. An active tab eval cannot reach is refused by Chrome
           inside chrome.scripting.executeScript, so the guest replies
           EvalError("Cannot access a chrome:// URL") and the CLI maps every
           EvalError to E_EVAL; the engine's E_TARGET_NOT_FOUND is reserved for
           a surface that is not open or a call with no tab id. That is true of
           the engine pinned here, not only of old ones, so this match retires
           when the engine distinguishes an unreachable target from a thrown
           expression, which no version has done yet. What it matches is the
           browser's own refusal and the scheme in the url, neither of which is
           CLI copy. */
        const unreachable =
          code === "E_TARGET_NOT_FOUND" ||
          /cannot access|chrome-extension:\/\/|chrome:\/\/|no active tab|missing host permission/i.test(
            JSON.stringify(parsed.error ?? ""),
          );
        if (parsed.ok === false && unreachable) {
          parsed.hint =
            "The active tab could not be reached: it is a browser or extension page, a site outside the extension's host permissions, or there is no active tab. Navigate the dev browser to a page the extension may script, or pass url (match pattern) or tab to pick one; extension_dom_snapshot with listTabs: true lists open tabs.";
        }
        return actFrameJson(parsed);
      }
    } catch {
      // non-JSON payload; pass through untouched
    }
  }
  return raw;
}
