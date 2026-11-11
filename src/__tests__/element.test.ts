import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, it, expect, afterEach, vi } from "vitest";

import { unpackedExtensionId } from "../lib/extension-identity";
import { evalTokenPresent } from "../lib/session-paths";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

const cliCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);

      return JSON.stringify({ ok: true });
    },
  };
});

let cdpPort: { port: number; source: "contract" } | null = { port: 9222, source: "contract" };
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => cdpPort };
});

type Target = { id: string; type: string; url: string; title: string };
type ScriptKind = "locate" | "point" | "dom-click" | "fill" | "text" | "focus";
let cdpTargets: Target[] = [];
const evaluations: Array<{ kind: ScriptKind; expression: string; sessionId?: string }> = [];
const mouse: Array<Record<string, unknown>> = [];
let pageAnswer: (kind: ScriptKind, polls: number) => unknown = () => ({ matches: 0 });
let attached = 0;
let disconnected = 0;

function scriptKind(expression: string): ScriptKind {
  if (expression.includes("scrollIntoView")) return "point";
  if (expression.includes("el.click()")) return "dom-click";
  if (expression.includes('new Event("input"')) return "fill";
  if (expression.includes("truncated: full.length")) return "text";
  if (expression.includes("focused:")) return "focus";

  return "locate";
}

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    async attachToTarget(targetId: string) {
      attached += 1;

      return `session-${targetId}`;
    }
    async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        const kind = scriptKind(expression);
        evaluations.push({ kind, expression, sessionId });

        return { result: { type: "object", value: pageAnswer(kind, evaluations.length) } };
      }

      if (method === "Input.dispatchMouseEvent") mouse.push({ ...params, sessionId });

      return {};
    }
    disconnect() {
      disconnected += 1;
    }
  }

  return { CDPClient };
});

const element = await import("../tools/element");
const { locateScript, pointScript, domClickScript, fillScript, textScript, focusScript, ELEMENT_ACTIONS } = await import("../lib/element-act");
const { tools } = await import("../index");
const { TOOL_POLICY, isToolListed, DEFAULT_SERVER_OPTIONS } = await import("../lib/tool-policy");

const tmpDirs: string[] = [];

function project(manifest: Record<string, unknown>, browser = "chrome"): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-element-"));
  tmpDirs.push(dir);
  const distPath = path.join(dir, "dist", browser);
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));

  return { dir, id: unpackedExtensionId(distPath) };
}

const MV3 = { manifest_version: 3, name: "F", action: { default_popup: "popup.html" } };

const popupOpen = (id: string, targetId = "pop"): Target => ({
  id: targetId,
  type: "page",
  url: `chrome-extension://${id}/popup.html`,
  title: "Popup",
});

const button = {
  tag: "button",
  id: "save",
  type: "submit",
  text: "Save",
  disabled: false,
  readOnly: false,
  editable: false,
  visible: true,
  rect: { x: 10, y: 20, width: 80, height: 30 },
};

const field = { ...button, tag: "input", id: "name", type: "text", text: "", editable: true };

afterEach(() => {
  cliCalls.length = 0;
  evaluations.length = 0;
  mouse.length = 0;
  cdpTargets = [];
  cdpPort = { port: 9222, source: "contract" };
  pageAnswer = () => ({ matches: 0 });
  attached = 0;
  disconnected = 0;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_element is registered as a local act that needs no eval gate", () => {
  it("is listed in the local group with ten bounded actions and an untrusted fence", () => {
    expect(tools.map((t) => t.schema.name)).toContain("extension_element");
    expect(isToolListed("extension_element", DEFAULT_SERVER_OPTIONS)).toBe(true);
    expect(TOOL_POLICY.extension_element).toMatchObject({ group: "local", untrusted: true });
    expect(TOOL_POLICY.extension_element.annotations.readOnlyHint).toBe(false);
    expect(ELEMENT_ACTIONS).toEqual(["click", "fill", "text", "wait", "move", "press", "release", "type", "key", "scroll"]);
    expect(element.schema.inputSchema.required).toEqual(["projectPath", "action"]);
    expect(element.schema.description).not.toMatch(/allowEval: true/);
  });

  it("builds page scripts that parse as JavaScript and carry the selector and value as data, never as code", () => {
    const selector = 'button[data-x="1"]';
    const value = '"); alert(1); ("';

    for (const source of [locateScript(selector), pointScript(selector), domClickScript(selector), fillScript(selector, value), textScript(selector), focusScript(selector)]) {
      expect(() => new vm.Script(source)).not.toThrow();
      expect(source).toContain(JSON.stringify(selector));
    }

    expect(fillScript(selector, value)).toContain(JSON.stringify(value));
    expect(fillScript(selector, value)).toContain(`var value = ${JSON.stringify(value)};`);
  });
});

describe("extension_element click", () => {
  it("sends a real mouse press and release at the element's center over CDP, with no eval token and no engine verb", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 1, element: button, point: { x: 50, y: 35 }, covered: false });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "popup", browser: "chrome" }));

    expect(evalTokenPresent(p.dir, "chrome")).toBe(false);
    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("acted");
    expect(result.value).toMatchObject({ action: "click", selector: "#save", input: "mouse", element: { tag: "button", id: "save" }, target: { targetId: "pop" } });
    expect(evaluations.map((e) => e.kind)).toEqual(["point"]);
    expect(evaluations[0].sessionId).toBe("session-pop");
    expect(mouse.map((m) => m.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[1]).toMatchObject({ x: 50, y: 35, button: "left", clickCount: 1, sessionId: "session-pop" });
    expect(result.hint).toContain("user gesture");
    expect(result.hint).toContain("extension_element action: \"text\"");
    expect(disconnected).toBe(1);
  });

  it("falls back to a DOM click when another element covers the center, and says so", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = (kind) =>
      kind === "point"
        ? { matches: 1, element: button, point: { x: 50, y: 35 }, covered: true }
        : { matches: 1, element: button, clicked: true };

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("acted");
    expect(result.value.input).toBe("dom");
    expect(mouse).toEqual([]);
    expect(evaluations.map((e) => e.kind)).toEqual(["point", "dom-click"]);
    expect(result.warnings.join(" ")).toContain("another element covers the center");
  });

  it("falls back to a DOM click when the element has no visible box", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = (kind) =>
      kind === "point"
        ? { matches: 1, element: { ...button, visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } } }
        : { matches: 1, element: button, clicked: true };

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "popup", browser: "chrome" }));

    expect(result.status).toBe("acted");
    expect(result.value.input).toBe("dom");
    expect(mouse).toEqual([]);
    expect(result.warnings.join(" ")).toContain("no visible box");
  });
});

describe("extension_element fill and text", () => {
  it("fills a field and answers acted with the field's new summary", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 1, element: { ...field, text: "Ada" }, filled: true });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "fill", selector: "#name", value: "Ada", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("acted");
    expect(result.value).toMatchObject({ action: "fill", input: "dom", element: { tag: "input", text: "Ada" } });
    expect(evaluations.map((e) => e.kind)).toEqual(["fill"]);
    expect(evaluations[0].expression).toContain(JSON.stringify("Ada"));
    expect(result.hint).toContain("input and change events");
  });

  it("refuses fill without a value before touching the session", async () => {
    const p = project(MV3);

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "fill", selector: "#name", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.message).toContain("needs value");
    expect(attached).toBe(0);
  });

  it("answers not-editable with the reason for a disabled field, a read-only field, a button and a missing option", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["disabled", { ...field, disabled: true, editable: false }, "is disabled"],
      ["read-only", { ...field, readOnly: true, editable: false }, "is read-only"],
      ["not-a-field", button, "not a field"],
      ["no-such-option", { ...field, tag: "select", type: undefined }, "has no option"],
    ];

    for (const [reason, summary, words] of cases) {
      pageAnswer = () => ({ matches: 1, element: summary, notEditable: reason });

      const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "fill", selector: "#name", value: "x", context: "popup", browser: "chrome" }));

      expect(result.ok, reason).toBe(false);
      expect(result.status, reason).toBe("not-editable");
      expect(result.error.code, reason).toBe("E_ELEMENT_NOT_EDITABLE");
      expect(result.error.message, reason).toContain(words);
      expect(result.value.reason, reason).toBe(reason);
    }

    expect(mouse).toEqual([]);
  });

  it("reads an element's text", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 1, element: { ...button, tag: "p", id: "status", type: undefined }, text: "Saved 3 items", truncated: false });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "text", selector: "#status", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("text");
    expect(result.value.text).toBe("Saved 3 items");
    expect(result.value.truncated).toBe(false);
    expect(evaluations.map((e) => e.kind)).toEqual(["text"]);
    expect(mouse).toEqual([]);
  });
});

describe("extension_element answers a fixed status when the selector does not resolve to one element", () => {
  it("no element matches", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 0 });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#nope", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("no-match");
    expect(result.error.code).toBe("E_ELEMENT_NOT_FOUND");
    expect(result.error.message).toContain("nothing was done");
    expect(result.value.matches).toBe(0);
    expect(result.hint).toContain('action: "wait"');
    expect(mouse).toEqual([]);
  });

  it("N elements match, with the first few listed", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 3, elements: [button, { ...button, id: "cancel", text: "Cancel" }, { ...button, id: "close", text: "Close" }] });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "button", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("ambiguous");
    expect(result.error.code).toBe("E_ELEMENT_AMBIGUOUS");
    expect(result.error.message).toContain("3 elements match");
    expect(result.value.elements.map((e: { id: string }) => e.id)).toEqual(["save", "cancel", "close"]);
    expect(mouse).toEqual([]);
  });

  it("an invalid selector is a bad request, not a page exception", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ invalidSelector: "'#[' is not a valid selector" });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "text", selector: "#[", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.name).toBe("BadSelector");
  });
});

describe("extension_element wait", () => {
  it("polls until the one matching element is visible", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = (_kind, polls) => (polls < 3 ? { matches: 0 } : { matches: 1, element: button });

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "wait", selector: "#save", context: "popup", browser: "chrome", timeout: 3_000 }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("visible");
    expect(result.value.polls).toBe(3);
    expect(evaluations.map((e) => e.kind)).toEqual(["locate", "locate", "locate"]);
    expect(attached).toBe(1);
    expect(result.hint).toContain('action: "click"');
  });

  it("times out with the last count when the element never shows, within the bounded budget", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 1, element: { ...button, visible: false } });
    const started = Date.now();

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "wait", selector: "#save", context: "popup", browser: "chrome", timeout: 100 }));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.error.code).toBe("E_WAIT_TIMEOUT");
    expect(result.error.message).toContain("never became visible");
    expect(result.value.matches).toBe(1);
    expect(result.value.budgetMs).toBe(500);
    expect(result.value.polls).toBeGreaterThanOrEqual(2);
    expect(result.hint).toContain("Never sleep");
  });
});

describe("extension_element picks its target the way extension_eval and extension_dom_snapshot do", () => {
  it("a declared surface that is not open answers no-target with the extension_open call", async () => {
    const p = project(MV3);
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "popup", browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("no-target");
    expect(result.error.code).toBe("E_NO_TARGET");
    expect(result.hint).toContain('extension_open surface: "popup"');
    expect(attached).toBe(0);
  });

  it("a surface the manifest does not declare answers no-surface", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "options", browser: "chrome" }));

    expect(result.status).toBe("no-surface");
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
  });

  it("a web page is picked by url, and a url that matches different pages is refused", async () => {
    const p = project(MV3);
    cdpTargets = [
      { id: "a", type: "page", url: "https://example.com/", title: "Example" },
      { id: "b", type: "page", url: "https://example.com/other", title: "Other" },
    ];

    pageAnswer = () => ({ matches: 1, element: button, point: { x: 1, y: 1 }, covered: false });

    const one = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", url: "example.com/other", browser: "chrome" }));
    expect(one.status).toBe("acted");
    expect(one.value.target).toEqual({ targetId: "b", url: "https://example.com/other" });

    const two = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", url: "example.com", browser: "chrome" }));
    expect(two.ok).toBe(false);
    expect(two.status).toBe("ambiguous-target");
    expect(two.error.code).toBe("E_AMBIGUOUS_TARGET");

    const none = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", url: "nowhere.test", browser: "chrome" }));
    expect(none.status).toBe("no-matching-target");
    expect(none.error.code).toBe("E_NO_MATCHING_TARGET");
  });

  it("a targetId that is gone answers target-not-found with the live targets", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "text", selector: "#save", targetId: "gone", browser: "chrome" }));

    expect(result.status).toBe("target-not-found");
    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(result.value.liveTargets).toEqual([{ targetId: "pop", url: `chrome-extension://${p.id}/popup.html` }]);
  });

  it("no context, url or targetId is a bad request that names the three", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "text", selector: "#save", browser: "chrome" }));

    expect(result.status).toBe("bad-request");
    expect(result.error.message).toContain("context");
    expect(result.error.message).toContain("targetId");
  });

  it("refuses on Firefox with the reason and the two routes, touching no debug port", async () => {
    const p = project(MV3, "firefox");

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "popup", browser: "firefox" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unsupported-browser");
    expect(result.error.code).toBe("E_UNSUPPORTED_BROWSER");
    expect(result.error.message).toContain("control channel carries no element verb");
    expect(result.hint).toContain('browser: "chrome"');
    expect(result.hint).toContain("extension_eval");
    expect(attached).toBe(0);
    expect(cliCalls).toEqual([]);
  });

  it("answers no-session when the session has no CDP port", async () => {
    const p = project(MV3);
    cdpPort = null;

    const result = JSON.parse(await element.handler({ projectPath: p.dir, action: "click", selector: "#save", context: "popup", browser: "chrome" }));

    expect(result.status).toBe("no-session");
    expect(result.error.code).toBe("E_NO_SESSION");
    expect(attached).toBe(0);
  });
});

describe("extension_element sends trusted input over the debug port", () => {
  it("answers sent with trusted: true on the picked page, warns when the point is covered, and refuses a bad request before attaching", async () => {
    const p = project(MV3);
    cdpTargets = [popupOpen(p.id)];
    pageAnswer = () => ({ matches: 1, element: button, point: { x: 50, y: 35 }, covered: true });
    const sent = JSON.parse(await element.handler({ projectPath: p.dir, context: "popup", action: "move", selector: "#save", points: [{ x: 60, y: 40 }] }));
    expect(sent).toMatchObject({ ok: true, status: "sent", value: { action: "move", trusted: true, path: [{ x: 50, y: 35 }, { x: 60, y: 40 }] } });
    expect(mouse.map((m) => [m.type, m.sessionId])).toEqual([["mouseMoved", "session-pop"], ["mouseMoved", "session-pop"]]);
    expect(sent.hint).toContain("isTrusted: true");
    expect(sent.warnings.join(" ")).toContain("covers");
    attached = 0;
    const refused = JSON.parse(await element.handler({ projectPath: p.dir, context: "popup", action: "key", key: "Hyperspace" }));
    expect(refused).toMatchObject({ ok: false, status: "bad-request" });
    expect(attached).toBe(0);
  });
});
