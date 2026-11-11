// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as sleep } from "node:timers/promises";

import { CDPClient } from "./cdp";

export const ELEMENT_ACTIONS = ["click", "fill", "text", "wait"] as const;

export type ElementAction = (typeof ELEMENT_ACTIONS)[number];

export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MIN_MS = 500;
export const WAIT_MAX_MS = 30_000;
export const WAIT_POLL_MS = 250;
export const TEXT_CAP = 4_000;

export interface ElementSummary {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  text: string;
  disabled: boolean;
  readOnly: boolean;
  editable: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export type NotEditableReason = "disabled" | "read-only" | "not-a-field" | "no-such-option";

export type ElementOutcome =
  | { kind: "acted"; action: "click" | "fill"; element: ElementSummary; input: "mouse" | "dom"; note?: string }
  | { kind: "text"; element: ElementSummary; text: string; truncated: boolean }
  | { kind: "visible"; element: ElementSummary; polls: number; elapsedMs: number }
  | { kind: "no-match"; polls?: number; elapsedMs?: number }
  | { kind: "ambiguous"; matches: number; elements: ElementSummary[] }
  | { kind: "not-editable"; element: ElementSummary; reason: NotEditableReason }
  | { kind: "timeout"; matches: number; element?: ElementSummary; polls: number; elapsedMs: number }
  | { kind: "bad-selector"; message: string }
  | { kind: "failed"; message: string; timedOut: boolean };

type PageRead =
  | { invalidSelector: string }
  | { matches: 0 }
  | { matches: number; elements: ElementSummary[] }
  | { matches: 1; element: ElementSummary; text?: string; truncated?: boolean; notEditable?: NotEditableReason; point?: { x: number; y: number }; covered?: boolean; filled?: boolean; clicked?: boolean };

const SUMMARY_SOURCE = `function summary(el) {
  var rect = el.getBoundingClientRect();
  var text = (el.value !== undefined && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? String(el.value) : (el.innerText || el.textContent || "")).replace(/\\s+/g, " ").trim();
  var style = window.getComputedStyle(el);
  var visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && (typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
  var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true;
  var buttonLike = el.tagName === "INPUT" && /^(button|submit|reset|checkbox|radio|file|hidden|image|color|range)$/.test(String(el.type || "text").toLowerCase());
  var out = {
    tag: el.tagName.toLowerCase(),
    text: text.slice(0, 80),
    disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    readOnly: el.readOnly === true,
    editable: field && !buttonLike && el.disabled !== true && el.readOnly !== true,
    visible: visible,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  };
  if (el.id) out.id = el.id;
  if (el.getAttribute("name")) out.name = el.getAttribute("name");
  if (el.tagName === "INPUT" || el.tagName === "BUTTON") out.type = String(el.type || "").toLowerCase();
  if (el.getAttribute("role")) out.role = el.getAttribute("role");
  return out;
}`;

const RESOLVE_SOURCE = `function resolve(selector) {
  var list;
  try { list = document.querySelectorAll(selector); } catch (e) { return { invalidSelector: String((e && e.message) || e) }; }
  if (list.length === 0) return { matches: 0 };
  if (list.length > 1) return { matches: list.length, elements: Array.prototype.slice.call(list, 0, 5).map(summary) };
  return { matches: 1, el: list[0], element: summary(list[0]) };
}`;

function script(selector: string, body: string): string {
  return `(function () {
  ${SUMMARY_SOURCE}
  ${RESOLVE_SOURCE}
  var found = resolve(${JSON.stringify(selector)});
  if (found.matches !== 1) return found;
  var el = found.el;
  ${body}
})()`;
}

export function locateScript(selector: string): string {
  return script(selector, "return { matches: 1, element: found.element };");
}

export function textScript(selector: string): string {
  return script(
    selector,
    `var full = (el.value !== undefined && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? String(el.value) : (el.innerText || el.textContent || "")).replace(/[ \\t\\r]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n").trim();
  var cap = ${TEXT_CAP};
  return { matches: 1, element: found.element, text: full.slice(0, cap), truncated: full.length > cap };`,
  );
}

export function pointScript(selector: string): string {
  return script(
    selector,
    `if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });
  var element = summary(el);
  var rect = el.getBoundingClientRect();
  if (!element.visible) return { matches: 1, element: element };
  var x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  var top = document.elementFromPoint(x, y);
  var covered = !top || !(top === el || el.contains(top) || top.contains(el));
  return { matches: 1, element: element, point: { x: x, y: y }, covered: covered };`,
  );
}

export function domClickScript(selector: string): string {
  return script(selector, "el.click(); return { matches: 1, element: found.element, clicked: true };");
}

export function fillScript(selector: string, value: string): string {
  return script(
    selector,
    `var element = found.element;
  if (element.disabled) return { matches: 1, element: element, notEditable: "disabled" };
  if (element.readOnly) return { matches: 1, element: element, notEditable: "read-only" };
  if (!element.editable) return { matches: 1, element: element, notEditable: "not-a-field" };
  var value = ${JSON.stringify(value)};
  if (typeof el.focus === "function") el.focus();
  if (el.tagName === "SELECT") {
    var option = Array.prototype.find.call(el.options, function (o) { return o.value === value; }) ||
      Array.prototype.find.call(el.options, function (o) { return (o.textContent || "").trim() === value; });
    if (!option) return { matches: 1, element: element, notEditable: "no-such-option" };
    el.value = option.value;
  } else if (el.isContentEditable === true && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
    el.textContent = value;
  } else {
    var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value); else el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { matches: 1, element: summary(el), filled: true };`,
  );
}

export interface ElementRequest {
  action: ElementAction;
  selector: string;
  value?: string;
  timeoutMs?: number;
}

export function waitBudget(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return WAIT_DEFAULT_MS;

  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Math.round(timeoutMs)));
}

type EvaluateResponse = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

class PageSession {
  private readonly cdp = new CDPClient();
  private sessionId = "";

  constructor(
    private readonly port: number,
    private readonly targetId: string,
    private readonly commandTimeoutMs: number | undefined,
  ) {}

  async open(): Promise<void> {
    await this.cdp.connect(await CDPClient.discoverBrowserWsUrl(this.port));
    this.sessionId = await this.cdp.attachToTarget(this.targetId);
  }

  async read(expression: string): Promise<PageRead> {
    const response = (await this.cdp.sendCommand(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false, userGesture: true },
      this.sessionId,
      this.commandTimeoutMs,
    )) as EvaluateResponse | undefined;

    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;

      throw new Error(`the page threw while locating the element: ${details.exception?.description ?? details.text ?? "unknown error"}`);
    }

    const value = response?.result?.value;
    if (!value || typeof value !== "object") throw new Error("the page answered no element read");

    return value as PageRead;
  }

  async mouseClick(point: { x: number; y: number }): Promise<void> {
    const at = { x: Math.round(point.x), y: Math.round(point.y) };

    await this.cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, this.sessionId, this.commandTimeoutMs);
    await this.cdp.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, ...at },
      this.sessionId,
      this.commandTimeoutMs,
    );

    await this.cdp.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, ...at },
      this.sessionId,
      this.commandTimeoutMs,
    );
  }

  close(): void {
    try {
      this.cdp.disconnect();
    } catch {
    }
  }
}

function unresolved(read: PageRead): ElementOutcome | null {
  if ("invalidSelector" in read) return { kind: "bad-selector", message: read.invalidSelector };
  if (read.matches === 0) return { kind: "no-match" };
  if (read.matches > 1 && "elements" in read) return { kind: "ambiguous", matches: read.matches, elements: read.elements };

  return null;
}

async function waitVisible(page: PageSession, request: ElementRequest, clock = { now: () => Date.now(), sleep }): Promise<ElementOutcome> {
  const budgetMs = waitBudget(request.timeoutMs);
  const started = clock.now();
  let polls = 0;
  let last: PageRead = { matches: 0 };

  for (;;) {
    polls += 1;
    last = await page.read(locateScript(request.selector));
    if ("invalidSelector" in last) return { kind: "bad-selector", message: last.invalidSelector };

    if (last.matches === 1 && "element" in last && last.element.visible) {
      return { kind: "visible", element: last.element, polls, elapsedMs: clock.now() - started };
    }

    if (clock.now() - started + WAIT_POLL_MS >= budgetMs) break;

    await clock.sleep(WAIT_POLL_MS);
  }

  const elapsedMs = clock.now() - started;
  const element = last.matches === 1 && "element" in last ? last.element : undefined;

  return { kind: "timeout", matches: last.matches, ...(element ? { element } : {}), polls, elapsedMs };
}

async function clickOnce(page: PageSession, selector: string): Promise<ElementOutcome> {
  const located = await page.read(pointScript(selector));
  const refused = unresolved(located);
  if (refused) return refused;
  if (!("element" in located)) return { kind: "no-match" };

  if (located.point && !located.covered) {
    await page.mouseClick(located.point);

    return { kind: "acted", action: "click", element: located.element, input: "mouse" };
  }

  const clicked = await page.read(domClickScript(selector));
  const gone = unresolved(clicked);
  if (gone) return gone;

  return {
    kind: "acted",
    action: "click",
    element: "element" in clicked ? clicked.element : located.element,
    input: "dom",
    note: located.point
      ? "another element covers the center of this one, so the click was sent as a DOM click() on the element itself instead of a mouse press at that point; whatever covers it (an overlay, a modal) did not receive it."
      : "the element has no visible box (it is hidden or empty), so the click was sent as a DOM click() on it instead of a mouse press; listeners that need a pointer position did not see one.",
  };
}

async function fillOnce(page: PageSession, request: ElementRequest): Promise<ElementOutcome> {
  const filled = await page.read(fillScript(request.selector, request.value ?? ""));
  const refused = unresolved(filled);
  if (refused) return refused;
  if (!("element" in filled)) return { kind: "no-match" };
  if (filled.notEditable) return { kind: "not-editable", element: filled.element, reason: filled.notEditable };

  return { kind: "acted", action: "fill", element: filled.element, input: "dom" };
}

async function textOnce(page: PageSession, selector: string): Promise<ElementOutcome> {
  const read = await page.read(textScript(selector));
  const refused = unresolved(read);
  if (refused) return refused;
  if (!("element" in read)) return { kind: "no-match" };

  return { kind: "text", element: read.element, text: read.text ?? "", truncated: read.truncated === true };
}

export async function actOnElement(
  port: number,
  targetId: string,
  request: ElementRequest,
  commandTimeoutMs?: number,
): Promise<ElementOutcome> {
  const page = new PageSession(port, targetId, commandTimeoutMs);

  try {
    await page.open();

    if (request.action === "wait") return await waitVisible(page, request);
    if (request.action === "click") return await clickOnce(page, request.selector);
    if (request.action === "fill") return await fillOnce(page, request);

    return await textOnce(page, request.selector);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { kind: "failed", message, timedOut: /timed out/i.test(message) };
  } finally {
    page.close();
  }
}
