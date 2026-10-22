// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
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
import { EVAL_UNTIL_PROPERTY, evalUntilTruthy, pollTimeoutWithin, type EvalUntil } from "../lib/eval-until";
import { parseFrameObject } from "../lib/frame-json";
import {
  ambiguousSessionRefusal,
  resolveSessionBrowser,
} from "../lib/session-browser";
import { evalTokenPresent } from "../lib/session-paths";
import {
  isChromiumFamily,
  isGeckoFamily,
  WEBKIT_FAMILY,
} from "../lib/browser-family";
import {
  navigableUrl,
  pageMatchesUrl,
  readWebDriverSession,
  WebDriverClient,
  webdriverSessionEnded,
  webdriverSessionEndedHint,
  webdriverSessionEndedMessage,
  type WebDriverSessionInfo,
} from "../lib/webdriver";
import { manifestCandidates } from "../lib/project-manifest";
import {
  resolveCdpPort,
  resolveRdpPort,
  CDP_PORT_MISSING_HINT,
} from "../lib/cdp-port";
import { rdpEvaluateInTab, rdpListTabs, type RdpTab } from "../lib/rdp";
import { matchPatternCovers } from "../lib/match-patterns";
import {
  evaluateOnExtensionPage,
  readExtensionPageTargets,
  readExtensionWorkerTargets,
  wakeExtensionWorker,
  BACKGROUND_TARGET_TYPES,
} from "../lib/cdp-extension-page";
import { listPageTargets, matchTargetsByUrl } from "../lib/cdp-targets";
import { CDPClient } from "../lib/cdp";
import {
  AMBIGUOUS_TARGET_HINT,
  findGeckoTab,
  geckoRecency,
  geckoTabRef,
  identicalPickWarning,
  pickTarget,
  TARGET_ID_PROPERTY,
  targetNotFound,
  type TargetRef,
} from "../lib/target-pick";
import {
  declaredSurfaces,
  resolveExtensionId,
  surfaceDocument,
  SURFACE_MANIFEST_KEYS,
} from "./open";
import {
  EXTENSION_PAGE_CONTEXTS,
  extensionPageUnreachable,
  distinctUrls,
  geckoDocumentTab,
  geckoExtensionTabByUrl,
  geckoExtensionTabsByUrl,
  isExtensionUrl,
  mayNameExtensionTab,
  namesExtensionDocument,
  productionSessionCommand,
  surfaceForExtensionUrl,
  urlKey,
} from "../lib/extension-surfaces";
import { executeScriptExpression } from "./inspect-gecko";
import { SAFARI_EVAL_LIMIT, safariContextRefusal } from "../lib/safari-eval";

const pageRef = (t: { targetId: string; url: string }): TargetRef => ({ targetId: t.targetId, url: t.url });

export const schema = {
  name: "extension_eval",
  description:
    `Evaluate an expression in a running extension context: the background, an extension surface (popup, options, sidebar, devtools, newtab, history, bookmarks), a content script or a page, picked by context, url, tab or targetId. Start the session with allowEval:true (extension_dev), which writes a 0600 session token; without that token every route of this tool, the debug port included, answers eval-disabled. A returned promise is awaited; a value that cannot be cloned (a DOM node, a function) comes back as its string form. To wait for a condition that is still settling (a model loading, an element appearing), pass until: {} (or {timeoutMs, intervalMs}) and the eval repeats until its value is truthy, answering that value, or the last one on timeout. Debug-port evaluates run with a user gesture, so gesture-gated APIs (permissions.request, sidePanel.open) can succeed here and still fail when the extension's own code calls them. Naming a tab the browser refuses to script (page-not-scriptable, extension-page-unreachable) needs Extension.js 4.1.34, not yet released; on 4.1.33 such a refusal still answers as a missing target. ${SAFARI_EVAL_LIMIT} Not for reading a page's structure: that is extension_dom_snapshot, which also lists tabs and targets. Pass \`targetId\` (the target.targetId extension_open answers, or one from extension_dom_snapshot listTargets:true) to evaluate in that exact page over the debug port; context, url and tab are then ignored.`,
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
        description:
          "Where to evaluate. Default background, except on a Chromium MV3 session (the default template) where it defaults to page, the active tab; background on Chromium goes over the debug port (the service worker). For content and page, pass `url` to pick the tab, or omit both `url` and `tab` for the active tab; a numeric `tab` only disambiguates, and a url that matches several tabs showing the same page evaluates in the most recently active one and warns with the others' targetIds. Extension surfaces (popup, options, sidebar, devtools) and override pages (newtab, history, bookmarks) need no tab id but must already be open: open one with extension_open first, because a closed one returns an explicit error. On a Chromium MV3 session those pages, and page with a chrome-extension:// url, evaluate over CDP, the inspector path the extension page CSP does not govern; elsewhere they evaluate over the in-bundle relay. On Firefox a document whose content security policy forbids eval (the extension's own pages, or a site's) is evaluated over the debugger protocol instead, which takes one expression; a page inside the extension that is no declared surface (pages/*) is reached the same way by page and its moz-extension:// url once a tab shows it. An extension_start session's pages carry no relay, so there a surface shown in a tab (options) and an extension page url are evaluated over the debugger protocol too, while a surface in its own window (popup) is not reachable and the answer says so. The one case where a promise is not awaited is Firefox MV2 without the scripting API, where the expression runs through tabs.executeScript and must return a synchronous value.",
      },
      url: { type: "string", description: "content/page: pick the tab by url (match pattern, then substring). Preferred over `tab`." },
      tab: { type: "number", description: "Numeric chrome.tabs id, only to disambiguate when several tabs match." },
      targetId: TARGET_ID_PROPERTY,
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
      until: EVAL_UNTIL_PROPERTY,
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

export function declaredBackgroundTargetType(
  projectPath: string,
  browser: string,
): "service_worker" | "background_page" | null {
  const version = chromiumManifestVersion(projectPath, browser);

  return version === 3 ? "service_worker" : version === 2 ? "background_page" : null;
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

    const declaredType = declaredBackgroundTargetType(args.projectPath, browser);
    const backgroundTargets = <T extends { type: string }>(targets: T[]): T[] =>
      targets.filter((t) => BACKGROUND_TARGET_TYPES.has(t.type) && (declaredType === null || t.type === declaredType));
    let workers = backgroundTargets(workersRead.targets);
    const offscreenDocuments =
      declaredType === "service_worker" ? workersRead.targets.filter((t) => t.type === "background_page") : [];
    const wakeWarnings: string[] = offscreenDocuments.map(
      (doc) =>
        `An offscreen document is also open at ${doc.url}. It is not the background: it lacks chrome.storage and most extension APIs, so it was not evaluated in. To evaluate in it, pass context: "page", url: "${doc.url}".`,
    );

    if (workers.length === 0) {
      const wake = await wakeExtensionWorker(resolved.port, extensionId);
      const woken = wake.woken ? backgroundTargets(wake.targets) : [];

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
            message: `No running background for chrome-extension://${extensionId}/: Chrome stops an idle MV3 service worker and lists no target for it, and starting it through ServiceWorker.startWorker did not bring one back: ${wake.woken ? "no service worker was listed, only targets that are not the background" : wake.reason}.`,
          },
          warnings: wakeWarnings,
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
  if (context === "page" && distinctUrls(targets).length > 1) return ambiguousUrl(wanted, targets.map(pageRef));

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
  const warnings = [identicalPickWarning(pageRef(target), targets.slice(1).map(pageRef), "chromium")];

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

function webdriverSessionEndedFrame(browser: string, info: WebDriverSessionInfo): string {
  return envelope({
    ok: false,
    command: schema.name,
    status: "webdriver-session-ended",
    error: {
      code: "E_WEBDRIVER_SESSION_ENDED",
      message: webdriverSessionEndedMessage(info, browser),
    },
    value: { browser, webdriverPort: info.port, webdriverSessionId: info.sessionId },
    hint: webdriverSessionEndedHint(browser),
  });
}

async function evaluateOnWebKitPage(
  args: ActArgs & { expression: string },
  browser: string,
  info: WebDriverSessionInfo,
): Promise<string> {
  const client = new WebDriverClient(info);
  const warnings: string[] = [];

  try {
    if (args.url) {
      const current = await client.currentUrl().catch((error: unknown) => {
        if (webdriverSessionEnded(error)) throw error;

        return null;
      });

      if (!pageMatchesUrl(current, args.url)) {
        const destination = navigableUrl(args.url);

        if (!destination) {
          return envelope({
            ok: false,
            command: schema.name,
            status: "no-matching-target",
            error: {
              code: "E_NO_MATCHING_TARGET",
              message: `The Safari automation window shows ${current ?? "an unreadable url"}, which ${args.url} does not match (as a document, a match pattern or a substring), and ${args.url} is not an address the window can be sent to.`,
            },
            value: { browser, url: current },
            hint: "Pass a full url or a host and port (such as 127.0.0.1:8765) to navigate the window there, or open the page first with extension_open url and retry.",
          });
        }

        if (destination !== args.url.trim()) {
          warnings.push(`${args.url} names no scheme, so the window was sent to ${destination}, the address Chromium and Firefox would match it against.`);
        }

        await client.navigate(destination);
      }
    }

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
      warnings,
      hint: "Evaluated in the Safari automation window's main world over the dev session's WebDriver connection.",
    });
  } catch (error) {
    if (webdriverSessionEnded(error)) return webdriverSessionEndedFrame(browser, info);

    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: {
        code: "E_EVAL",
        name: "EvalError",
        message: error instanceof Error ? error.message : String(error),
      },
      hint: "The expression threw, the window could not load the url, or the automation window is gone. extension_doctor names which; a session that ended needs extension_dev again.",
    });
  }
}

const RELAY_INSTEAD = "__relay_instead__";

export function isBrowserErrorPage(url: string): boolean {
  return /^(chrome|edge)-error:\/\//.test(url);
}

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
  const pick = pickTarget(live, pageRef);
  const pickWarning =
    pick.kind === "one"
      ? identicalPickWarning(pageRef(target), pick.others.map(pageRef), "chromium")
      : `${live.length} tabs match ${url}; evaluated in ${target.url} (targetId ${target.targetId}). The others: ${live
          .slice(1)
          .map((t) => `${t.targetId} (${t.url})`)
          .join(", ")}. Pass targetId to pick another.`;
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
    warnings: [pickWarning, outcome.note ?? null],
    hint: `Evaluated over CDP in ${target.url} (target ${target.targetId}), the page's main world through the inspector, which the site's CSP and Trusted Types do not govern. Pass context: "content" for the extension's isolated world instead.`,
  });
}

const TRUSTED_TYPES_REFUSAL = /Trusted Type/i;

const RELAY_POLL_MS = 300;
const RELAY_DEFAULT_BUDGET_MS = 30_000;

type EngineRun = (expression: string) => Promise<string>;

function engineEvalRun(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
): EngineRun {
  return (expression) =>
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
}

async function settleThroughEngine(
  args: ActArgs & { expression: string },
  where: string,
  run: EngineRun,
): Promise<{ settled: boolean; answer: string }> {
  const token = crypto.randomUUID();
  const budgetMs = args.timeout ?? RELAY_DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let raw = await run(relaySafeExpression(args.expression, token));
  let parsed = parseFrameObject(raw);

  if (!parsed || parsed.ok !== true) return { settled: false, answer: raw };

  let frame = readRelayFrame(parsed.value);
  if (!frame) return { settled: false, answer: raw };

  let polls = 0;

  while (!frame.done) {
    if (Date.now() >= deadline) {
      return {
        settled: true,
        answer: envelope({
          ok: false,
          command: schema.name,
          status: "eval-pending",
          error: {
            code: "E_WAIT_TIMEOUT",
            name: "EvalPending",
            message: `The expression returned a promise that had not settled after ${budgetMs} ms; it is still running in ${where}.`,
          },
          value: { context: args.context ?? null, token, polls },
          hint: `Its outcome lands in globalThis.${RELAY_MARK}[${JSON.stringify(token)}] inside ${where} when it settles ({done, ok, value}): read it with extension_eval in the same context, or pass a larger timeout to wait here.`,
        }),
      };
    }

    await sleep(RELAY_POLL_MS);
    polls += 1;
    raw = await run(relayPollExpression(token));
    parsed = parseFrameObject(raw);
    if (!parsed || parsed.ok !== true) return { settled: true, answer: raw };

    const next = readRelayFrame(parsed.value);
    if (!next) return { settled: true, answer: raw };

    frame = next;
  }

  if (frame.ok === false) {
    return {
      settled: true,
      answer: envelope({
        ok: false,
        command: schema.name,
        status: "eval-failed",
        error: {
          code: "E_EVAL",
          name: frame.name || "EvalError",
          message: frame.message || "the expression rejected",
        },
        hint: `The expression threw, or the promise it returned rejected, inside ${where}.`,
      }),
    };
  }

  parsed.value = frame.value === undefined ? null : frame.value;

  if (polls > 0) {
    parsed.hint =
      `The expression returned a promise; ${where} settled it and this call polled ${polls} time${polls === 1 ? "" : "s"} for the result. ${
      typeof parsed.hint === "string" ? parsed.hint : ""}`;
  }

  return { settled: true, answer: actFrameJson(parsed) };
}

async function evaluateThroughRelay(
  args: ActArgs & { expression: string },
  browser: string,
  context: string,
): Promise<string> {
  const run = engineEvalRun(args, browser, context);
  const outcome = await settleThroughEngine(
    { ...args, context },
    `the ${context} page`,
    run,
  );

  if (!outcome.settled && isGeckoFamily(browser) && cspRefusedFrame(parseFrameObject(outcome.answer))) {
    return evaluatePastSurfaceCsp(args, context, run);
  }

  return outcome.answer;
}

const NOT_CLONEABLE = /non-structured-clon|could not be cloned|DataCloneError/i;

function notCloneableRefusal(raw: string): string | null {
  const parsed = parseFrameObject(raw);
  if (!parsed || parsed.ok !== false) return null;
  if (!NOT_CLONEABLE.test(String(parsed.error?.message ?? ""))) return null;

  return envelope({
    ok: false,
    command: schema.name,
    status: "eval-result-not-cloneable",
    error: {
      code: "E_EVAL_NOT_CLONEABLE",
      name: "ResultNotCloneable",
      message: String(parsed.error.message),
      ...(typeof parsed.error?.engine === "string" ? { engine: parsed.error.engine } : {}),
    },
    hint: "The tab was found and the expression ran, but the browser could not copy its result back: a promise, a DOM node or a function is not cloneable. Return a synchronous, cloneable value (plain data, or JSON.stringify of it), or use context: \"background\", which awaits a returned promise.",
  });
}

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
  const parsed = parseFrameObject(raw);
  if (!parsed || !cspRefusedFrame(parsed)) return null;

  parsed.error.name = "CspBlocksEval";
  parsed.hint = cspRefusalHint(context);
  if (typeof parsed.error.hint === "string") delete parsed.error.hint;

  return actFrameJson(parsed);
}

const NO_SCRIPTING_API = /scripting is not available/i;

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

async function evaluatePastSurfaceCsp(
  args: ActArgs & { expression: string },
  context: string,
  run: (expression: string) => Promise<string>,
): Promise<string> {
  if (!isSingleExpression(args.expression)) return notOneExpression();

  const direct = await run(args.expression);
  const frame = parseFrameObject(direct);
  if (!frame) return direct;
  if (cspRefusedFrame(frame)) return explainCspRefusal(direct, context) ?? direct;

  if (frame.ok === true && frame.value === undefined) {
    frame.value = null;

    return actFrameJson(frame);
  }

  return direct;
}

const sameDocumentUrl = (a: unknown, b: string): boolean => urlKey(String(a ?? ""), b) === urlKey(b, b);

function ambiguousUrl(url: string, candidates: TargetRef[]): string {
  const urls = distinctUrls(candidates);

  return envelope({
    ok: false,
    command: schema.name,
    status: "ambiguous-target",
    error: {
      code: "E_AMBIGUOUS_TARGET",
      name: "AmbiguousTabUrl",
      message: `url: ${url} matches ${urls.length} open tabs that show different pages (${urls.join(", ")}); refusing to guess which one you mean, so nothing was evaluated.`,
    },
    value: { matchingUrls: urls, matchingTargets: candidates },
    hint: AMBIGUOUS_TARGET_HINT,
  });
}

type TabsSeen = { matched: number; refs?: TargetRef[] };

function tabByUrl(tabs: RdpTab[], url: string, seen?: TabsSeen): RdpTab | undefined {
  const exact = tabs.filter((tab) => sameDocumentUrl(tab.url, url));
  const covered = exact.length
    ? exact
    : tabs.filter((tab) => matchPatternCovers(url, String(tab.url ?? "")));
  const candidates = covered.length
    ? covered
    : tabs.filter((tab) => String(tab.url ?? "").includes(url));
  const ordered = [...candidates].sort(geckoRecency);

  if (seen) {
    seen.matched = ordered.length;
    seen.refs = ordered.map(geckoTabRef);
  }

  return ordered[0];
}

function manyTabsWarning(seen: TabsSeen): string {
  const [picked, ...others] = seen.refs ?? [];
  if (picked && distinctUrls([picked, ...others]).length === 1) return identicalPickWarning(picked, others, "gecko") ?? "";

  return `${seen.matched} open tabs matched the url; the selected one, else the most recently created, was used${picked ? ` (targetId ${picked.targetId})` : ""}. Narrow the url or pass targetId to pick another.`;
}

function sameTabsSeen(matching: RdpTab[]): TabsSeen | undefined {
  return matching.length > 1 ? { matched: matching.length, refs: [...matching].sort(geckoRecency).map(geckoTabRef) } : undefined;
}

async function evaluateInGeckoTab(
  args: ActArgs & { expression: string },
  browser: string,
  select: (tabs: RdpTab[]) => RdpTab | null | undefined,
  missing: string,
  seen?: TabsSeen,
): Promise<string | null> {
  const resolved = await resolveRdpPort(args.projectPath, browser, {
    waitMs: 3_000,
    graceMs: 1_000,
  });
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
    return envelope({
      ok: true,
      command: schema.name,
      status: "ok",
      value: outcome.value === undefined ? null : outcome.value,
      warnings: [
        `Evaluated in the tab showing ${outcome.tab.url || "an unknown url"}${outcome.tab.title ? ` ("${outcome.tab.title}")` : ""}.`,
        seen && seen.matched > 1 ? manyTabsWarning(seen) : null,
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

/* @invariant
 * The engine answers E_TARGET_NOT_FOUND (or, since it names a refused injection, the E_PAGE_NOT_SCRIPTABLE or
 * E_EXTENSION_PAGE_UNREACHABLE this server maps it to) for an extension page it could not reach: a surface whose page carries no relay (a
 * production build gets the control producer in its background only) or a moz-extension:// tab that script injection
 * cannot enter. Neither ran the expression, so the tab is evaluated over the debugger protocol only when it exists there,
 * and a missing tab keeps the engine's own answer.
 */
const UNREACHED_TAB_CODES = new Set(["E_TARGET_NOT_FOUND", "E_PAGE_NOT_SCRIPTABLE", "E_EXTENSION_PAGE_UNREACHABLE"]);

async function evaluateExtensionPageOverProtocol(
  args: ActArgs & { expression: string },
  browser: string,
  select: (tabs: RdpTab[]) => RdpTab | undefined,
  target: string,
  raw: string,
  extensionDocument = true,
  candidates?: (tabs: RdpTab[]) => RdpTab[],
): Promise<string> {
  if (!isGeckoFamily(browser)) return raw;

  const refused = parseFrameObject(raw);
  if (!refused || refused.ok !== false || !UNREACHED_TAB_CODES.has(String(refused.error?.code))) return raw;

  const resolved = await resolveRdpPort(args.projectPath, browser, { waitMs: 1_000, graceMs: 500 });

  if (!resolved) {
    const production = extensionDocument ? productionSessionCommand(args.projectPath, browser) : null;

    return production ? extensionPageUnreachable(schema.name, browser, production, target) : raw;
  }

  let tabs: RdpTab[];

  try {
    tabs = await rdpListTabs(resolved.port);
  } catch {
    return raw;
  }

  const matching = candidates ? candidates(tabs) : [];
  if (distinctUrls(matching).length > 1) return ambiguousUrl(target, matching.map(geckoTabRef));

  if (!select(tabs)) {
    const production = extensionDocument ? productionSessionCommand(args.projectPath, browser) : null;

    return production ? extensionPageUnreachable(schema.name, browser, production, target, "no-tab") : raw;
  }

  if (!isSingleExpression(args.expression)) return notOneExpression();

  return (
    (await evaluateInGeckoTab(args, browser, select, `No open tab shows ${target}.`, sameTabsSeen(matching))) ?? raw
  );
}

function backgroundRouteRefusedStatements(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
  raw: string,
): boolean {
  if (!isGeckoFamily(browser) || (context ?? "background") !== "background") return false;

  const failed = parseFrameObject(raw);
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
  if (!cspRefusedFrame(parseFrameObject(raw))) return null;
  if (!args.url && args.tab != null) return null;
  if (!isSingleExpression(args.expression)) return notOneExpression();

  const url = args.url;
  const seen: TabsSeen = { matched: 0 };

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

const INJECTION_REFUSED = /missing host permission|cannot access|cannot be scripted/i;

const MOZ_EXTENSION_TAB = /^moz-extension:\/\/[^/]+\//;

function extensionPageRoutes(projectPath: string, browser: string): string {
  const declared = declaredSurfaces(projectPath, browser) ?? [];

  return ` If the tab shows a page inside the extension, pass url with that page's path (for example "${surfaceDocument(projectPath, browser, declared[0] ?? "") ?? "pages/panel.html"}"), which is read over the debugger protocol when the session records a debugger port${declared.length ? `, or evaluate the declared surface with context: "${declared[0]}"` : ""}.`;
}

async function evaluateExtensionTabBeforeInjection(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
  raw: string,
): Promise<string | null> {
  if (context !== "page" || !isGeckoFamily(browser) || args.tab != null) return null;
  if (args.url && !mayNameExtensionTab(args.url)) return null;

  const refused = parseFrameObject(raw);
  if (!refused || refused.ok !== false) return null;

  const message = String(refused.error?.message ?? "");

  if (
    !NO_SCRIPTING_API.test(message) &&
    refused.error?.code !== "E_TARGET_NOT_FOUND" &&
    !INJECTION_REFUSED.test(message)
  ) {
    return null;
  }

  const resolved = await resolveRdpPort(args.projectPath, browser, { waitMs: 1_000, graceMs: 500 });
  if (!resolved) return null;

  let tabs: RdpTab[];

  try {
    tabs = await rdpListTabs(resolved.port);
  } catch {
    return null;
  }

  const url = args.url;
  const matching = url ? geckoExtensionTabsByUrl(tabs, url) : [];
  if (url && distinctUrls(matching).length > 1) return ambiguousUrl(url, matching.map(geckoTabRef));

  const select = url
    ? (list: RdpTab[]) => geckoExtensionTabByUrl(list, url)
    : (list: RdpTab[]) =>
        list.find((tab) => tab.selected === true && MOZ_EXTENSION_TAB.test(String(tab.url ?? "")));
  const tab = select(tabs);
  if (!tab) return null;

  if (!isSingleExpression(args.expression)) return notOneExpression();

  const answer = await evaluateInGeckoTab(args, browser, select, `No open tab shows ${url ?? String(tab.url)}.`, sameTabsSeen(matching));
  if (answer === null || url) return answer;

  const parsed = parseFrameObject(answer);
  if (!parsed) return answer;

  const document = String(tab.url).replace(MOZ_EXTENSION_TAB, "").replace(/[?#].*$/, "");
  const surface = surfaceForExtensionUrl(args.projectPath, browser, String(tab.url));
  addWarning(
    parsed,
    `No url was given and the active tab shows the extension's own page ${document}, which script injection cannot reach, so this evaluated in that tab over the debugger protocol. Pass url: "${document}"${surface ? ` or context: "${surface.context}"` : ""} to name it next time.`,
  );

  return actFrameJson(parsed);
}

async function evaluateThroughExecuteScript(
  args: ActArgs & { expression: string },
  browser: string,
  context: string | undefined,
  raw: string,
): Promise<string | null> {
  if (context !== "page" && context !== "content") return null;
  if (isChromiumFamily(browser)) return null;

  const parsed = parseFrameObject(raw);
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
  const frame = parseFrameObject(wrapped);
  if (!frame || frame.ok !== true) return wrapped ?? raw;

  const value = frame.value;

  if (value && typeof value === "object" && typeof value.error === "string") {
    return envelope({
      ok: false,
      command: schema.name,
      status: "eval-failed",
      error: { code: "E_EVAL", name: "EvalError", message: value.error },
      hint: `Because ${why}, the expression went through tabs.executeScript from the background and that call failed. The tab must be a web page the extension holds host permissions for; extension pages cannot be injected into.${INJECTION_REFUSED.test(value.error) ? extensionPageRoutes(args.projectPath, browser) : ""}`,
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

function evalDisabled(): string {
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

function noDebugPort(browser: string, protocol: string): string {
  return envelope({
    ok: false,
    command: schema.name,
    status: "no-session",
    error: {
      code: "E_NO_SESSION",
      name: "NoSession",
      message: `No live ${browser} session with a debug port (${protocol}) for this project, so targetId has no browser to ask. Start extension_dev and extension_wait for ready.`,
    },
  });
}

async function evaluateByTargetId(
  args: ActArgs & { expression: string },
  browser: string,
  targetId: string,
): Promise<string> {
  if (!isChromiumFamily(browser) && !isGeckoFamily(browser)) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        name: "BadRequest",
        message: `${browser} lists no debug-port targets, so targetId cannot pick a page there.`,
      },
      hint: "Pass url instead.",
    });
  }

  if (!evalTokenPresent(args.projectPath, browser)) return evalDisabled();

  if (isGeckoFamily(browser)) {
    if (!isSingleExpression(args.expression)) return notOneExpression();

    const resolved = await resolveRdpPort(args.projectPath, browser, { waitMs: 3_000, graceMs: 1_000 });
    if (!resolved) return noDebugPort(browser, "RDP");

    let tabs: RdpTab[];

    try {
      tabs = await rdpListTabs(resolved.port);
    } catch (err) {
      return targetsUnreadable(err instanceof Error ? err.message : String(err));
    }

    if (!findGeckoTab(tabs, targetId)) return targetNotFound(schema.name, targetId, tabs.map(geckoTabRef));

    return (
      (await evaluateInGeckoTab(args, browser, (live) => findGeckoTab(live, targetId), `The tab with targetId ${targetId} closed before the expression ran.`)) ??
      noDebugPort(browser, "RDP")
    );
  }

  const resolved = await resolveCdpPort(args.projectPath, browser);
  if (!resolved) return noDebugPort(browser, "CDP");

  let live: TargetRef[];

  try {
    live = (await CDPClient.discoverTargets(resolved.port))
      .filter((t) => !String(t.url ?? "").startsWith("devtools://"))
      .map((t) => ({ targetId: String(t.id), url: String(t.url ?? "") }));
  } catch (err) {
    return targetsUnreadable(err instanceof Error ? err.message : String(err));
  }

  const target = live.find((t) => t.targetId === targetId);
  if (!target) return targetNotFound(schema.name, targetId, live, { projectPath: args.projectPath, browser });

  const outcome = await evaluateOnExtensionPage(resolved.port, targetId, args.expression, args.timeout);

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
        ? `The expression threw inside ${target.url} (targetId ${targetId}); it ran over CDP in that target's main world.`
        : "The session's debug port refused the call or the target went away. extension_doctor names which.",
    });
  }

  return envelope({
    ok: true,
    command: schema.name,
    status: "evaluated",
    value: outcome.value,
    warnings: [outcome.note ?? null],
    hint: `Evaluated over CDP in ${target.url} (targetId ${targetId}), the target's main world through the inspector, which neither the page's CSP nor the extension's governs; a promise is awaited before returning.`,
  });
}

export async function handler(
  args: ActArgs & { expression: string; until?: EvalUntil; targetId?: string },
): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  const { until, ...once } = args;
  if (!until) return evaluateOnce(once);

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  return evalUntilTruthy(
    schema.name,
    (pollTimeoutMs) => evaluateOnce({ ...once, timeout: pollTimeoutWithin(once.timeout, pollTimeoutMs) }),
    browser,
    args.context,
    until,
  );
}

async function evaluateOnce(
  args: ActArgs & { expression: string; targetId?: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const raw = await evaluateRouted(args, browser);

  return safariContextRefusal(schema.name, raw, browser, args.context) ?? raw;
}

async function evaluateRouted(
  args: ActArgs & { expression: string; targetId?: string },
  browser: string,
): Promise<string> {
  if (args.targetId) return evaluateByTargetId(args, browser, args.targetId);

  if (WEBKIT_FAMILY.has(browser) && args.context === "page") {
    const info = readWebDriverSession(args.projectPath, browser);
    if (info) return evaluateOnWebKitPage(args, browser, info);
  }

  const defaulted =
    !args.context &&
    resolveDefaultEvalContext(args.projectPath, browser) === "page";
  const context = defaulted ? "page" : args.context;

  if (wantsExtensionPageOverCdp(args.projectPath, browser, context, args.url)) {
    if (!evalTokenPresent(args.projectPath, browser)) return evalDisabled();

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

  if (context === "page" && isExtensionUrl(args.url)) {
    const surface = surfaceForExtensionUrl(
      args.projectPath,
      browser,
      args.url as string,
    );

    if (surface) {
      const raw = await evaluateExtensionPageOverProtocol(
        args,
        browser,
        (tabs) => geckoDocumentTab(tabs, surface.document),
        args.url as string,
        await evaluateThroughRelay(
          { ...args, url: undefined, tab: undefined },
          browser,
          surface.context,
        ),
      );
      const parsed = parseFrameObject(raw);

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
    const document = surfaceDocument(args.projectPath, browser, context);
    const relayed = await evaluateThroughRelay(args, browser, context);

    return document
      ? evaluateExtensionPageOverProtocol(
          args,
          browser,
          (tabs) => geckoDocumentTab(tabs, document),
          `the ${context} document (${document})`,
          relayed,
        )
      : relayed;
  }

  const run = engineEvalRun(args, browser, context);
  const inTab = context === "page" || context === "content";
  const engine = inTab
    ? await settleThroughEngine(
        { ...args, context },
        context === "page" ? "the tab's page world" : "the tab's content-script world",
        run,
      )
    : { settled: false, answer: await run(args.expression) };
  const raw = engine.answer;

  if (!engine.settled) {
    const extensionTab = await evaluateExtensionTabBeforeInjection(args, browser, context, raw);
    if (extensionTab !== null) return extensionTab;

    const mv2Fallback = await evaluateThroughExecuteScript(args, browser, context, raw);
    if (mv2Fallback !== null) return mv2Fallback;

    const pastSiteCsp = await evaluatePagePastSiteCsp(args, browser, context, raw);
    if (pastSiteCsp !== null) return pastSiteCsp;

    if (backgroundRouteRefusedStatements(args, browser, context, raw)) {
      return notOneExpression();
    }

    const cspRefusal = explainCspRefusal(raw, context);
    if (cspRefusal !== null) return cspRefusal;

    const trustedTypes = parseFrameObject(raw);

    if (
      trustedTypes?.ok === false &&
      TRUSTED_TYPES_REFUSAL.test(String(trustedTypes.error?.message ?? ""))
    ) {
      trustedTypes.hint =
        "This site enforces Trusted Types, which refuse a string evaluated inside the page. Pass url so the tab is evaluated over CDP (the inspector path the policy does not govern), or use context: \"content\" for a DOM read from the extension's isolated world.";

      return actFrameJson(trustedTypes);
    }

    const notCloneable = notCloneableRefusal(raw);
    if (notCloneable !== null) return notCloneable;

    if (context === "page" && args.url && mayNameExtensionTab(args.url)) {
      const url = args.url;
      const overProtocol = await evaluateExtensionPageOverProtocol(
        args,
        browser,
        (tabs) => geckoExtensionTabByUrl(tabs, url),
        url,
        raw,
        namesExtensionDocument(args.projectPath, browser, url),
        (tabs) => geckoExtensionTabsByUrl(tabs, url),
      );
      if (overProtocol !== raw) return overProtocol;
    }
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
    }
  }

  if (defaulted) {
    try {
      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === "object") {
        addWarning(
          parsed,
          'No context given: defaulted to "page" (the active tab). Pass context: "background" to evaluate in the service worker, which this tool reaches over the debug port.',
        );

        const code =
          typeof parsed.error?.code === "string" ? parsed.error.code : "";
        const named = code === "E_PAGE_NOT_SCRIPTABLE" || code === "E_EXTENSION_PAGE_UNREACHABLE";
        const unreachable =
          !named &&
          (code === "E_TARGET_NOT_FOUND" ||
            /cannot access|chrome-extension:\/\/|chrome:\/\/|no active tab|missing host permission/i.test(
              JSON.stringify(parsed.error ?? ""),
            ));

        if (parsed.ok === false && unreachable) {
          parsed.hint =
            "The active tab could not be reached: it is a browser or extension page, a site outside the extension's host permissions, or there is no active tab. Navigate the dev browser to a page the extension may script, or pass url (match pattern) or tab to pick one; extension_dom_snapshot with listTabs: true lists open tabs.";
        }

        return actFrameJson(parsed);
      }
    } catch {
    }
  }

  return raw;
}
