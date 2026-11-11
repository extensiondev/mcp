import { describe, it, expect } from "vitest";

import { inputRequestRefusal, sendInput, type InputRequest } from "../lib/element-input";

import type { ElementSummary, PageRead } from "../lib/element-types";

const button: ElementSummary = {
  tag: "button",
  id: "save",
  text: "Save",
  disabled: false,
  readOnly: false,
  editable: false,
  visible: true,
  rect: { x: 10, y: 20, width: 80, height: 30 },
};

function fakePage(read: PageRead = { matches: 1, element: button, point: { x: 50, y: 35 }, covered: false }) {
  const sent: Array<{ method: string } & Record<string, unknown>> = [];
  const scripts: string[] = [];

  return {
    sent,
    scripts,
    page: {
      read: async (expression: string) => {
        scripts.push(expression);

        return read;
      },
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, ...params });
      },
    },
  };
}

const SCRIPTS = { point: (selector: string) => `point ${selector}`, focus: (selector: string) => `focus ${selector}` };

const run = (fake: ReturnType<typeof fakePage>, request: InputRequest) => sendInput(fake.page, request, SCRIPTS);

describe("trusted input goes out as CDP Input events and never runs page script for a bare point", () => {
  it("moves from the selector's center along the rounded points, one mouseMoved each", async () => {
    const fake = fakePage();
    const outcome = await run(fake, { action: "move", selector: "#save", points: [{ x: 60, y: 40 }, { x: 70.4, y: 45.6 }] });

    expect(outcome).toMatchObject({ kind: "input", trusted: true, input: "mouse", events: 3, element: { id: "save" } });
    expect(fake.sent.map((s) => [s.method, s.type, s.x, s.y])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved", 50, 35],
      ["Input.dispatchMouseEvent", "mouseMoved", 60, 40],
      ["Input.dispatchMouseEvent", "mouseMoved", 70, 46],
    ]);
  });

  it("presses with a button and modifier mask at x and y, releases there, and scrolls by a wheel delta", async () => {
    const fake = fakePage();

    await run(fake, { action: "press", x: 12, y: 34, button: "right", modifiers: ["Shift", "Meta"] });
    await run(fake, { action: "release", x: 12, y: 34, button: "right" });
    await run(fake, { action: "scroll", x: 5, y: 6, deltaY: 240 });

    expect(fake.scripts).toEqual([]);
    expect(fake.sent.map((s) => s.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
    expect(fake.sent[1]).toMatchObject({ x: 12, y: 34, button: "right", clickCount: 1, modifiers: 12 });
    expect(fake.sent[3]).toMatchObject({ x: 5, y: 6, deltaX: 0, deltaY: 240 });
  });

  it("focuses the selector, then types one key down and up per character, a newline as Enter", async () => {
    const fake = fakePage({ matches: 1, element: button, focused: false });
    const outcome = await run(fake, { action: "type", selector: "#name", text: "Hi\n" });

    expect(outcome).toMatchObject({ kind: "input", action: "type", input: "keyboard", characters: 3, events: 6, focused: false });
    expect(fake.scripts).toEqual(["focus #name"]);
    expect(fake.sent[0]).toMatchObject({ method: "Input.dispatchKeyEvent", type: "keyDown", key: "H", text: "H" });
    expect(fake.sent[4]).toMatchObject({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  });

  it("sends a named key or a letter with its code and modifiers", async () => {
    const fake = fakePage();

    await run(fake, { action: "key", key: "Esc" });
    await run(fake, { action: "key", key: "a", modifiers: ["Control"] });

    expect(fake.sent.map((s) => [s.type, s.key, s.code, s.windowsVirtualKeyCode, s.modifiers])).toEqual([
      ["keyDown", "Escape", "Escape", 27, 0],
      ["keyUp", "Escape", "Escape", 27, 0],
      ["keyDown", "a", "KeyA", 65, 2],
      ["keyUp", "a", "KeyA", 65, 2],
    ]);
  });

  it("answers no-box for an element without a visible point and sends nothing", async () => {
    const fake = fakePage({ matches: 1, element: { ...button, visible: false } });

    expect(await run(fake, { action: "press", selector: "#save" })).toMatchObject({ kind: "no-box" });
    expect(fake.sent).toEqual([]);
  });

  it.each([
    [{ action: "move" }, "points"],
    [{ action: "press" }, "x and y"],
    [{ action: "scroll", x: 1, y: 1 }, "deltaX"],
    [{ action: "type" }, "text"],
    [{ action: "key" }, "key"],
    [{ action: "key", key: "Hyperspace" }, "Hyperspace"],
    [{ action: "press", x: 1, y: 1, button: "thumb" }, "button takes"],
    [{ action: "key", key: "a", modifiers: ["Hyper"] }, "modifiers takes"],
  ] as Array<[InputRequest, string]>)("refuses %j before any event", (request, words) => {
    expect(inputRequestRefusal(request)).toContain(words);
  });
});
