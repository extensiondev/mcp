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
import {
  actOnElement,
  ELEMENT_ACTIONS,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  waitBudget,
  type ElementAction,
  type ElementOutcome,
} from "../lib/element-act";
import { inputRequestRefusal, isInputAction, MODIFIERS, MOUSE_BUTTONS, type InputOutcome } from "../lib/element-input";
import { envelope, type EnvelopeInit } from "../lib/envelope";
import { EXTENSION_PAGE_CONTEXTS } from "../lib/extension-surfaces";
import { noSessionEnvelope } from "../lib/production-receipt";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";
import { TARGET_ID_PROPERTY } from "../lib/target-pick";
import { pickTargetFor, type Picked } from "./element-target";

export const schema = {
  name: "extension_element",
  description:
    "Click, fill, read or wait for one element by CSS selector, or send trusted mouse and key input (move, press, release, type, key, scroll) in an open surface, a page by url or a targetId. Runs no caller code, so no allowEval; Chromium only.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      action: {
        type: "string",
        enum: [...ELEMENT_ACTIONS],
        description: "click (a real mouse press), fill, text, wait (until visible); move, press, release, type, key, scroll send trusted input.",
      },
      selector: { type: "string", description: "CSS selector matching exactly one element (the point for input actions; focused before type and key)." },
      value: { type: "string", description: "fill: the value to set." },
      x: { type: "number", description: "press, release, scroll: the point's x in CSS pixels of the viewport, when no selector." },
      y: { type: "number", description: "The point's y, with x." },
      points: {
        type: "array",
        items: { type: "object", properties: { x: { type: "number", description: "CSS pixels." }, y: { type: "number", description: "CSS pixels." } }, required: ["x", "y"] },
        description: "move: the path, one trusted mousemove per point; a selector's center goes first.",
      },
      button: { type: "string", enum: [...MOUSE_BUTTONS], description: "press, release: the mouse button (default left)." },
      text: { type: "string", description: "type: the characters, one key down and up each; a newline is Enter." },
      key: { type: "string", description: "key: a key name (Enter, Escape, Tab, ArrowDown, F5) or one character." },
      modifiers: { type: "array", items: { type: "string", enum: [...MODIFIERS] }, description: "Modifiers held during the input." },
      deltaX: { type: "number", description: "scroll: wheel delta in CSS pixels (positive scrolls right)." },
      deltaY: { type: "number", description: "scroll: wheel delta in CSS pixels (positive scrolls down)." },
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
    required: ["projectPath", "action"],
  },
};

export interface ElementArgs {
  projectPath: string;
  action: ElementAction;
  selector?: string;
  value?: string;
  x?: number;
  y?: number;
  points?: Array<{ x: number; y: number }>;
  button?: string;
  text?: string;
  key?: string;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
  context?: string;
  url?: string;
  targetId?: string;
  browser?: string;
  timeout?: number;
}

const refuse = (init: Omit<EnvelopeInit, "ok" | "command">): string => envelope({ ok: false, command: schema.name, ...init });

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

const TRUSTED_NOTE =
  "The events are trusted: they enter through the browser's input pipeline over the debug port (Input.dispatchMouseEvent, Input.dispatchKeyEvent), so page handlers see isTrusted: true and a user gesture, which nothing extension_eval dispatches can give.";

const at = (point: { x: number; y: number }): string => `(${point.x}, ${point.y})`;

function sentSentence(outcome: Extract<InputOutcome, { kind: "input" }>, where: string): string {
  switch (outcome.action) {
    case "move":
      return `${outcome.events} trusted mousemove event${outcome.events === 1 ? "" : "s"} went along the path in ${where}, ending at ${at(outcome.path![outcome.path!.length - 1]!)}.`;
    case "press":
      return `A trusted ${outcome.button} button press was sent at ${at(outcome.at!)} in ${where}; the button stays held until action: "release" at a point lets it go, so a press and a release at different points make a drag.`;
    case "release":
      return `A trusted ${outcome.button} button release was sent at ${at(outcome.at!)} in ${where}.`;
    case "scroll":
      return `A trusted wheel scroll of ${at(outcome.delta!)} was sent at ${at(outcome.at!)} in ${where}.`;
    case "type":
      return `${outcome.characters} character${outcome.characters === 1 ? "" : "s"} were typed as trusted key down and up events into the focused element of ${where}.`;
    default:
      return `A trusted ${outcome.key} key press (down and up${outcome.modifiers.length ? `, with ${outcome.modifiers.join("+")}` : ""}) was sent to the focused element of ${where}.`;
  }
}

function sentAnswer(args: ElementArgs, picked: Picked, outcome: Extract<InputOutcome, { kind: "input" }>): string {
  const { kind, ...sent } = outcome;

  return envelope({
    ok: true,
    command: schema.name,
    status: "sent",
    value: { ...sent, selector: args.selector, target: picked.target },
    warnings: [
      ...picked.warnings,
      outcome.covered ? "Another element covers the center of the one the selector names, so the input landed on whatever covers it (an overlay, a modal), the way a person's would." : null,
      outcome.focused === false ? "The element did not take focus (document.activeElement stayed elsewhere after focus()), so the keys went to whatever has focus in the page." : null,
    ],
    hint: `${sentSentence(outcome, picked.where)} ${TRUSTED_NOTE} ${NEXT_READ}`,
  });
}

function answer(args: ElementArgs, picked: Picked, outcome: ElementOutcome): string {
  const base = { action: args.action, selector: args.selector, target: picked.target };
  const warnings = picked.warnings;

  switch (outcome.kind) {
    case "input":
      return sentAnswer(args, picked, outcome);
    case "no-box":
      return refuse({
        status: "no-visible-box",
        error: {
          code: "E_ELEMENT_NOT_VISIBLE",
          name: "ElementNotVisible",
          message: `The ${outcome.element.tag} matching ${JSON.stringify(args.selector)} in ${picked.where} has no visible box (it is hidden or empty), so there is no point to send input at; nothing was done.`,
        },
        value: { ...base, element: outcome.element },
        warnings,
        hint: 'Wait for it with action: "wait", pick an element that renders, or pass x and y for a point of the viewport.',
      });
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

  const refusal = isInputAction(args.action)
    ? inputRequestRefusal({ ...args, action: args.action })
    : typeof args.selector !== "string" || args.selector.trim() === ""
      ? `action: "${args.action}" needs selector, a CSS selector matching exactly one element.`
      : null;

  if (refusal) {
    return refuse({
      status: "bad-request",
      error: { code: "E_BAD_REQUEST", name: "BadRequest", message: refusal },
      hint: "Nothing was sent. extension_dom_snapshot (include: [\"elements\"]) lists the page's elements with a selector each, and their rect gives points in CSS pixels.",
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
    {
      action: args.action,
      selector: args.selector,
      value: args.value,
      timeoutMs: args.timeout,
      points: args.points,
      x: args.x,
      y: args.y,
      button: args.button,
      text: args.text,
      key: args.key,
      modifiers: args.modifiers,
      deltaX: args.deltaX,
      deltaY: args.deltaY,
    },
    args.action === "wait" ? undefined : args.timeout,
  );

  return answer(args, picked, outcome);
}
