// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { unresolved, type ElementSummary, type PageRead, type Point, type ReadFailure } from "./element-types";

export const INPUT_ACTIONS = ["move", "press", "release", "type", "key", "scroll"] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];

export const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

export type MouseButton = (typeof MOUSE_BUTTONS)[number];

export const MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;

export type Modifier = (typeof MODIFIERS)[number];

export const POINTS_MAX = 100;
export const TEXT_MAX = 1_000;

const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export interface InputRequest {
  action: InputAction;
  selector?: string;
  points?: Point[];
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  key?: string;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
}

export type InputOutcome =
  | {
      kind: "input";
      action: InputAction;
      trusted: true;
      input: "mouse" | "keyboard";
      events: number;
      modifiers: Modifier[];
      at?: Point;
      path?: Point[];
      button?: MouseButton;
      delta?: Point;
      key?: string;
      characters?: number;
      element?: ElementSummary;
      focused?: boolean;
      covered?: boolean;
    }
  | { kind: "no-box"; element: ElementSummary };

export interface InputPage {
  read(expression: string): Promise<PageRead>;
  send(method: string, params: Record<string, unknown>): Promise<void>;
}

export interface InputScripts {
  point(selector: string): string;
  focus(selector: string): string;
}

interface KeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, Omit<KeyDescriptor, "key"> & { key?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9, text: "\t" },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  Space: { code: "Space", keyCode: 32, text: " ", key: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, keyCode: 112 + i }])),
};

const KEY_ALIASES: Record<string, string> = {
  Return: "Enter",
  Esc: "Escape",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Del: "Delete",
  " ": "Space",
  "\n": "Enter",
  "\r": "Enter",
  "\t": "Tab",
};

export const KEY_NAMES = Object.keys(NAMED_KEYS);

export function keyDescriptor(name: string): KeyDescriptor | null {
  const canonical = KEY_ALIASES[name] ?? name;
  const named = NAMED_KEYS[canonical];
  if (named) return { key: named.key ?? canonical, code: named.code, keyCode: named.keyCode, text: named.text };

  if ([...name].length !== 1) return null;

  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };

  return { key: name, code: "", keyCode: 0, text: name };
}

export function modifierMask(names: readonly string[] | undefined): number {
  return (names ?? []).reduce((mask, name) => mask | (MODIFIER_BITS[name as Modifier] ?? 0), 0);
}

const roundPoint = (point: Point): Point => ({ x: Math.round(point.x), y: Math.round(point.y) });

const isPoint = (value: unknown): value is Point =>
  !!value && typeof value === "object" && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);

const hasXY = (request: InputRequest): boolean => Number.isFinite(request.x) && Number.isFinite(request.y);

const POINT_WORDS = "a point: x and y in CSS pixels of the viewport, or a selector (its center is used)";

export function inputRequestRefusal(request: InputRequest): string | null {
  const unknownModifier = (request.modifiers ?? []).find((name) => !MODIFIERS.includes(name as Modifier));
  if (unknownModifier) return `modifiers takes ${MODIFIERS.join(", ")}; ${JSON.stringify(unknownModifier)} is not one of them.`;

  if (request.button !== undefined && !MOUSE_BUTTONS.includes(request.button as MouseButton)) {
    return `button takes ${MOUSE_BUTTONS.join(", ")}; ${JSON.stringify(request.button)} is not one of them.`;
  }

  if ((request.points ?? []).some((point) => !isPoint(point))) return "points takes a list of {x, y} objects in CSS pixels of the viewport.";
  if ((request.points ?? []).length > POINTS_MAX) return `points takes at most ${POINTS_MAX} points in one call; split a longer path over several calls.`;

  switch (request.action) {
    case "move":
      if (!request.selector && !(request.points ?? []).length) {
        return 'action: "move" needs points (a list of {x, y} in CSS pixels of the viewport) or a selector whose center starts the path.';
      }

      return null;
    case "press":
    case "release":
      return request.selector || hasXY(request) ? null : `action: "${request.action}" needs ${POINT_WORDS}.`;
    case "scroll":
      if (!request.selector && !hasXY(request)) return `action: "scroll" needs ${POINT_WORDS}.`;
      if (!Number.isFinite(request.deltaX) && !Number.isFinite(request.deltaY)) return 'action: "scroll" needs deltaX or deltaY, the wheel delta in CSS pixels (positive scrolls right or down).';

      return null;
    case "type":
      if (typeof request.text !== "string" || request.text.length === 0) return 'action: "type" needs text, the characters to send as key events.';
      if ([...request.text].length > TEXT_MAX) return `action: "type" sends at most ${TEXT_MAX} characters in one call; split a longer text over several calls.`;

      return null;

    case "key": {
      if (typeof request.key !== "string" || request.key.length === 0) return 'action: "key" needs key, a key name (Enter, Escape, Tab, ArrowDown, a letter or a digit).';
      if (!keyDescriptor(request.key)) return `${JSON.stringify(request.key)} is not a key this server knows: pass ${KEY_NAMES.join(", ")}, or one character (a letter, a digit or a sign).`;

      return null;
    }

    default:
      return null;
  }
}

type Located = { at: Point; element?: ElementSummary; covered?: boolean } | ReadFailure | { kind: "no-box"; element: ElementSummary };

async function locatePoint(page: InputPage, request: InputRequest, scripts: InputScripts): Promise<Located> {
  if (!request.selector) return { at: roundPoint({ x: request.x ?? 0, y: request.y ?? 0 }) };

  const read = await page.read(scripts.point(request.selector));
  const failed = unresolved(read);
  if (failed) return failed;
  if (!("element" in read)) return { kind: "no-match" };
  if (!read.point) return { kind: "no-box", element: read.element };

  return { at: roundPoint(read.point), element: read.element, covered: read.covered === true };
}

async function keyEvents(page: InputPage, descriptor: KeyDescriptor, modifiers: number): Promise<number> {
  const identity = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    modifiers,
  };

  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...identity,
    ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
  });

  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...identity });

  return 2;
}

export async function sendInput(page: InputPage, request: InputRequest, scripts: InputScripts): Promise<InputOutcome | ReadFailure> {
  const modifierNames = (request.modifiers ?? []) as Modifier[];
  const modifiers = modifierMask(modifierNames);
  const base = { kind: "input" as const, trusted: true as const, modifiers: modifierNames };

  if (request.action === "type" || request.action === "key") {
    let element: ElementSummary | undefined;
    let focused: boolean | undefined;

    if (request.selector) {
      const read = await page.read(scripts.focus(request.selector));
      const failed = unresolved(read);
      if (failed) return failed;
      if (!("element" in read)) return { kind: "no-match" };

      element = read.element;
      focused = read.focused === true;
    }

    if (request.action === "key") {
      const descriptor = keyDescriptor(request.key ?? "")!;
      const events = await keyEvents(page, descriptor, modifiers);

      return { ...base, action: "key", input: "keyboard", events, key: descriptor.key, element, focused };
    }

    const characters = [...(request.text ?? "")];
    let events = 0;

    for (const character of characters) {
      events += await keyEvents(page, keyDescriptor(character)!, modifiers);
    }

    return { ...base, action: "type", input: "keyboard", events, characters: characters.length, element, focused };
  }

  const located = await locatePoint(page, request, scripts);
  if ("kind" in located) return located;

  const { at, element, covered } = located;

  if (request.action === "move") {
    const path = [...(request.selector ? [at] : []), ...(request.points ?? []).map(roundPoint)];

    for (const point of path) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers });
    }

    return { ...base, action: "move", input: "mouse", events: path.length, path, element, covered };
  }

  if (request.action === "scroll") {
    const delta = { x: Number.isFinite(request.deltaX) ? Math.round(request.deltaX!) : 0, y: Number.isFinite(request.deltaY) ? Math.round(request.deltaY!) : 0 };

    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: delta.x, deltaY: delta.y, modifiers });

    return { ...base, action: "scroll", input: "mouse", events: 1, at, delta, element, covered };
  }

  const button = (request.button ?? "left") as MouseButton;
  const press = { button, clickCount: 1, x: at.x, y: at.y, modifiers };

  if (request.action === "press") {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, modifiers });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...press });

    return { ...base, action: "press", input: "mouse", events: 2, at, button, element, covered };
  }

  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });

  return { ...base, action: "release", input: "mouse", events: 1, at, button, element, covered };
}

export function isInputAction(action: string): action is InputAction {
  return INPUT_ACTIONS.includes(action as InputAction);
}
