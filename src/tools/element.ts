// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { SESSION_BROWSER, SESSION_PROJECT_PATH } from "../lib/common-schema";
import { isChromiumFamily } from "../lib/browser-family";
import { CDP_PORT_MISSING_HINT, resolveCdpPort } from "../lib/cdp-port";
import { readExtensionPageTargets } from "../lib/cdp-extension-page";
import { listPageTargets, matchTargetsByUrl, TARGET_ID_NOTE } from "../lib/cdp-targets";
import {
  actOnElement,
  ELEMENT_ACTIONS,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  waitBudget,
  type ElementAction,
  type ElementOutcome,
} from "../lib/element-act";
import { envelope, type EnvelopeInit } from "../lib/envelope";
import { EXTENSION_PAGE_CONTEXTS, distinctUrls } from "../lib/extension-surfaces";
import { noSessionEnvelope } from "../lib/production-receipt";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";
import {
  AMBIGUOUS_TARGET_HINT,
  identicalPickWarning,
  pickTarget,
  TARGET_ID_PROPERTY,
  targetNotFound,
  type TargetRef,
} from "../lib/target-pick";
import { resolveExtensionId, surfaceDocument, SURFACE_MANIFEST_KEYS } from "./open";

const BROWSER_ERROR_PAGE = /^(chrome|edge)-error:\/\//;

const isBrowserErrorPage = (url: string): boolean => BROWSER_ERROR_PAGE.test(url);

export const schema = {
  name: "extension_element",
  description:
    "Click, fill, read the text of, or wait for one element by CSS selector in an open surface, a page by url, or a targetId. Runs no caller code, so no allowEval; Chromium only; the selector must match one element.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      action: {
        type: "string",
        enum: [...ELEMENT_ACTIONS],
        description: "click (a real mouse press), fill, text, wait (until visible).",
      },
      selector: { type: "string", description: "CSS selector matching exactly one element." },
      value: { type: "string", description: "fill: the value to set." },
      context: {
        type: "string",
        enum: [...EXTENSION_PAGE_CONTEXTS],
        description: "An open surface (extension_open first).",
      },
      url: { type: "string", description: "A web page's tab by url." },
      targetId: TARGET_ID_PROPERTY,
      browser: SESSION_BROWSER,
      timeout: { type: "number", description: `Timeout ms; wait polls until it (default ${WAIT_DEFAULT_MS}, max ${WAIT_MAX_MS}).` },
    },
    required: ["projectPath", "action", "selector"],
  },
};

export interface ElementArgs {
  projectPath: string;
  action: ElementAction;
  selector: string;
  value?: string;
  context?: string;
  url?: string;
  targetId?: string;
  browser?: string;
  timeout?: number;
}

const refuse = (init: Omit<EnvelopeInit, "ok" | "command">): string => envelope({ ok: false, command: schema.name, ...init });

const pageRef = (t: { targetId: string; url: string }): TargetRef => ({ targetId: t.targetId, url: t.url });

type Picked = { target: TargetRef; where: string; warnings: Array<string | null> };

async function pickByTargetId(port: number, args: ElementArgs, browser: string, targetId: string): Promise<Picked | string> {
  let live: TargetRef[];

  try {
    live = (await listPageTargets(port)).map(pageRef);
  } catch (err) {
    return targetsUnreadable(err instanceof Error ? err.message : String(err));
  }

  const target = live.find((t) => t.targetId === targetId);
  if (!target) return targetNotFound(schema.name, targetId, live, { projectPath: args.projectPath, browser });

  return { target, where: `${target.url} (targetId ${targetId})`, warnings: [] };
}

async function pickByUrl(port: number, url: string): Promise<Picked | string> {
  let matches: Array<{ targetId: string; url: string; title: string }>;

  try {
    matches = matchTargetsByUrl(await listPageTargets(port), url).filter((t) => !isBrowserErrorPage(t.url));
  } catch (err) {
    return targetsUnreadable(err instanceof Error ? err.message : String(err));
  }

  if (matches.length === 0) {
    return refuse({
      status: "no-matching-target",
      error: {
        code: "E_NO_MATCHING_TARGET",
        name: "NoMatchingTarget",
        message: `No open page's url (or title) matches "${url}", so there is no document to act in.`,
      },
      hint: `Open the page first with extension_open (url), or pass a url that matches one open tab; extension_dom_snapshot with listTargets: true lists what is open. ${TARGET_ID_NOTE}`,
    });
  }

  const pick = pickTarget(matches, pageRef);

  if (pick.kind === "different") {
    return refuse({
      status: "ambiguous-target",
      error: {
        code: "E_AMBIGUOUS_TARGET",
        name: "AmbiguousTabUrl",
        message: `url: ${url} matches ${matches.length} open tabs that show different pages (${distinctUrls(matches).join(", ")}); refusing to guess which one you mean, so nothing was done.`,
      },
      value: { matchingTargets: matches.map(pageRef) },
      hint: AMBIGUOUS_TARGET_HINT,
    });
  }

  const target = pick.kind === "one" ? pick.target : matches[0];

  return {
    target: pageRef(target),
    where: `${target.url} (targetId ${target.targetId})`,
    warnings: [pick.kind === "one" ? identicalPickWarning(pageRef(target), pick.others.map(pageRef), "chromium") : null],
  };
}

async function pickSurface(port: number, args: ElementArgs, browser: string, context: string): Promise<Picked | string> {
  const document = surfaceDocument(args.projectPath, browser, context);

  if (!document) {
    const key = SURFACE_MANIFEST_KEYS[context] ?? context;

    return refuse({
      status: "no-surface",
      error: {
        code: "E_NO_SURFACE_DOCUMENT",
        name: "NoSurfaceDocument",
        message: `This extension declares no ${context}: nothing in its manifest sets ${key}, so there is no ${context} page to act in.`,
      },
      hint: `To add one, set ${key} in the manifest and rebuild.`,
    });
  }

  const extensionId = await resolveExtensionId(args.projectPath, browser);

  if (!extensionId) {
    return refuse({
      status: "no-extension-id",
      error: {
        code: "E_NO_EXTENSION_ID",
        name: "NoExtensionId",
        message: "Could not resolve the extension id from the live session's CDP targets.",
      },
      hint: `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`,
    });
  }

  const wanted = `chrome-extension://${extensionId}/${document}`;
  const read = await readExtensionPageTargets(port, wanted);
  if ("unreadable" in read) return targetsUnreadable(read.unreadable);

  const targets = read.targets.filter((t) => !isBrowserErrorPage(t.url));

  if (targets.length === 0) {
    return refuse({
      status: "no-target",
      error: {
        code: "E_NO_TARGET",
        name: "NoTarget",
        message: `No open page at ${wanted}, so there is no ${context} to act in; a surface has a target only while it is open.`,
      },
      value: { wanted },
      hint: `Open it first with extension_open surface: "${context}", then call extension_element again. extension_dom_snapshot with listTargets: true lists what is open.`,
    });
  }

  const target = targets[0];

  return {
    target: pageRef(target),
    where: `the ${context} (${target.url}, targetId ${target.targetId})`,
    warnings: [identicalPickWarning(pageRef(target), targets.slice(1).map(pageRef), "chromium")],
  };
}

function targetsUnreadable(why: string): string {
  return refuse({
    status: "targets-unreadable",
    error: {
      code: "E_CDP",
      name: "TargetsUnreadable",
      message: `Could not list the session's CDP targets: ${why}. Nothing was done.`,
    },
    hint: "The session's debug port did not answer. extension_doctor says whether the browser is still up; if it is, retry.",
  });
}

async function pickTargetFor(port: number, args: ElementArgs, browser: string): Promise<Picked | string> {
  if (args.targetId) return pickByTargetId(port, args, browser, args.targetId);

  const context = args.context ?? (args.url ? "page" : undefined);

  if (context === "page") {
    if (args.url) return pickByUrl(port, args.url);

    return refuse({
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        name: "BadRequest",
        message: 'context: "page" needs the tab named: pass url (a substring or * glob of its address) or targetId.',
      },
      hint: "extension_dom_snapshot with listTargets: true lists the open pages with their targetId.",
    });
  }

  if (context && EXTENSION_PAGE_CONTEXTS.includes(context)) return pickSurface(port, args, browser, context);

  return refuse({
    status: "bad-request",
    error: {
      code: "E_BAD_REQUEST",
      name: "BadRequest",
      message: "No element target named: pass context (an open surface such as popup or options), url for a web page, or targetId.",
    },
    hint: `Surfaces: ${EXTENSION_PAGE_CONTEXTS.join(", ")}. extension_dom_snapshot with listTargets: true lists what is open.`,
  });
}

function unsupportedBrowser(browser: string): string {
  return refuse({
    status: "unsupported-browser",
    error: {
      code: "E_UNSUPPORTED_BROWSER",
      name: "Unsupported",
      message: `extension_element acts over the browser's debug port (CDP), which ${browser} does not expose, and the dev session's control channel carries no element verb, so nothing was done.`,
    },
    hint: 'Run the session in a Chromium browser (extension_dev with browser: "chrome") for these verbs, or on this browser start it with allowEval: true and use extension_eval with a document.querySelector expression; extension_dom_snapshot still reads the page here.',
  });
}

const NEXT_READ = "Read what changed with extension_element action: \"text\" on the element you expect to update, or extension_dom_snapshot on the same context.";

function answer(args: ElementArgs, picked: Picked, outcome: ElementOutcome): string {
  const base = { action: args.action, selector: args.selector, target: picked.target };
  const warnings = picked.warnings;

  switch (outcome.kind) {
    case "acted":
      return envelope({
        ok: true,
        command: schema.name,
        status: "acted",
        value: { ...base, element: outcome.element, input: outcome.input },
        warnings: [...warnings, outcome.note ? `The click reached the element, but ${outcome.note}` : null],
        hint:
          outcome.action === "click"
            ? `${outcome.input === "mouse" ? "A mouse press and release were sent at the element's center in" : "A DOM click was sent to the element in"} ${picked.where}; it carries a user gesture. ${NEXT_READ}`
            : `The field in ${picked.where} now holds the value, with input and change events dispatched, so a framework bound to it saw the change. ${NEXT_READ}`,
      });
    case "text":
      return envelope({
        ok: true,
        command: schema.name,
        status: "text",
        value: { ...base, element: outcome.element, text: outcome.text, truncated: outcome.truncated },
        warnings,
        hint: `value.text is the element's ${/^(input|textarea|select)$/.test(outcome.element.tag) ? "current value" : "rendered text"} in ${picked.where}${outcome.truncated ? `, cut at ${outcome.text.length} characters` : ""}.`,
      });
    case "visible":
      return envelope({
        ok: true,
        command: schema.name,
        status: "visible",
        value: { ...base, element: outcome.element, polls: outcome.polls, elapsedMs: outcome.elapsedMs },
        warnings,
        hint: `The element is visible in ${picked.where} after ${outcome.elapsedMs} ms; act on it with action: "click" or "fill".`,
      });
    case "no-match":
      return refuse({
        status: "no-match",
        error: {
          code: "E_ELEMENT_NOT_FOUND",
          name: "ElementNotFound",
          message: `No element matches ${JSON.stringify(args.selector)} in ${picked.where}, so nothing was done.`,
        },
        value: { ...base, matches: 0 },
        warnings,
        hint: `extension_dom_snapshot (include: ["html"]) on the same context shows the markup to pick a selector from; if the element renders late, call extension_element with action: "wait" first.`,
      });
    case "ambiguous":
      return refuse({
        status: "ambiguous",
        error: {
          code: "E_ELEMENT_AMBIGUOUS",
          name: "ElementAmbiguous",
          message: `${outcome.matches} elements match ${JSON.stringify(args.selector)} in ${picked.where}; refusing to guess which one you mean, so nothing was done.`,
        },
        value: { ...base, matches: outcome.matches, elements: outcome.elements },
        warnings,
        hint: "Narrow the selector until it matches one element (an id, :nth-of-type, or a text-bearing attribute); value.elements lists the first five.",
      });
    case "not-editable":
      return refuse({
        status: "not-editable",
        error: {
          code: "E_ELEMENT_NOT_EDITABLE",
          name: "ElementNotEditable",
          message: notEditableSentence(args, outcome),
        },
        value: { ...base, element: outcome.element, reason: outcome.reason },
        warnings,
        hint:
          outcome.reason === "not-a-field"
            ? 'fill takes an input, textarea, select or contenteditable element; a button, checkbox or radio is acted on with action: "click".'
            : outcome.reason === "no-such-option"
              ? "Pass an option's value or its visible label as value; extension_element action: \"text\" on the select reads its current value."
              : "Enable the field first (the page's own logic does that), or pick the field the page lets the person type in.",
      });
    case "timeout":
      return refuse({
        status: "timeout",
        error: {
          code: "E_WAIT_TIMEOUT",
          name: "WaitTimeout",
          message:
            outcome.matches === 0
              ? `No element matched ${JSON.stringify(args.selector)} in ${picked.where} within ${outcome.elapsedMs} ms (${outcome.polls} polls).`
              : outcome.matches === 1
                ? `${JSON.stringify(args.selector)} matched one element in ${picked.where} but it never became visible within ${outcome.elapsedMs} ms (${outcome.polls} polls).`
                : `${JSON.stringify(args.selector)} matched ${outcome.matches} elements in ${picked.where} for the whole ${outcome.elapsedMs} ms (${outcome.polls} polls); wait needs exactly one.`,
        },
        value: { ...base, matches: outcome.matches, ...(outcome.element ? { element: outcome.element } : {}), polls: outcome.polls, elapsedMs: outcome.elapsedMs, budgetMs: waitBudget(args.timeout) },
        warnings,
        hint: `Call extension_element with action: "wait" again to keep waiting (timeout up to ${WAIT_MAX_MS} ms), or read the page with extension_dom_snapshot to see what rendered instead. Never sleep in a shell to wait.`,
      });
    case "bad-selector":
      return refuse({
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          name: "BadSelector",
          message: `${JSON.stringify(args.selector)} is not a valid CSS selector: ${outcome.message}`,
        },
        value: base,
        warnings,
        hint: "Pass a CSS selector the page's document.querySelectorAll accepts.",
      });
    default:
      return refuse({
        status: outcome.timedOut ? "cdp-timeout" : "cdp-failed",
        error: {
          code: "E_CDP",
          name: outcome.timedOut ? "CdpTimeout" : "CdpError",
          message: `${outcome.message}${args.action === "click" || args.action === "fill" ? " The act may have run in part; read the page's state before repeating it." : ""}`,
        },
        value: base,
        warnings,
        hint: "The session's debug port refused the call or the target went away. extension_doctor names which; a session that ended needs extension_dev again.",
      });
  }
}

function notEditableSentence(args: ElementArgs, outcome: Extract<ElementOutcome, { kind: "not-editable" }>): string {
  const what = `${outcome.element.tag}${outcome.element.type ? `[type=${outcome.element.type}]` : ""} matching ${JSON.stringify(args.selector)}`;

  if (outcome.reason === "disabled") return `The ${what} is disabled, so it takes no value; nothing was done.`;
  if (outcome.reason === "read-only") return `The ${what} is read-only, so it takes no value; nothing was done.`;
  if (outcome.reason === "no-such-option") return `The select matching ${JSON.stringify(args.selector)} has no option whose value or label is ${JSON.stringify(args.value ?? "")}; nothing was done.`;

  return `The ${what} is not a field that takes a value; nothing was done.`;
}

export async function handler(args: ElementArgs): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  if (args.action === "fill" && typeof args.value !== "string") {
    return refuse({
      status: "bad-request",
      error: { code: "E_BAD_REQUEST", name: "BadRequest", message: 'action: "fill" needs value, the text to put in the field.' },
      hint: 'Pass value (an empty string clears the field); to read the field instead, use action: "text".',
    });
  }

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  if (!isChromiumFamily(browser)) return unsupportedBrowser(browser);

  const resolved = await resolveCdpPort(args.projectPath, browser, { timeoutMs: args.timeout });

  if (!resolved) {
    return noSessionEnvelope({
      command: schema.name,
      projectPath: args.projectPath,
      browser,
      name: "NoSession",
      need: "so there is no page to act in",
      dev: {
        message: `No live ${browser} session with a debug port (CDP) for this project, so there is no page to act in. Start extension_dev and extension_wait for ready. ${CDP_PORT_MISSING_HINT}`,
      },
    });
  }

  const picked = await pickTargetFor(resolved.port, args, browser);
  if (typeof picked === "string") return picked;

  const outcome = await actOnElement(
    resolved.port,
    picked.target.targetId,
    { action: args.action, selector: args.selector, value: args.value, timeoutMs: args.timeout },
    args.action === "wait" ? undefined : args.timeout,
  );

  return answer(args, picked, outcome);
}
