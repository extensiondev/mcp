import vm from "node:vm";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as CdpPortModule from "../lib/cdp-port";
import type * as CdpExtensionPageModule from "../lib/cdp-extension-page";
import type * as RdpModule from "../lib/rdp";
import type { RdpTab } from "../lib/rdp";

type Attrs = Record<string, string>;

class FakeNode {
  nodeType = 1;
  tagName: string;
  attrs: Attrs;
  children: FakeNode[] = [];
  parentNode: FakeNode | FakeRoot | null = null;
  ownerDocument: FakeRoot;
  ownText: string;
  hidden = false;
  display = "";
  disabled?: boolean;
  readOnly?: boolean;
  checked?: boolean;
  value?: string;
  open?: boolean;
  multiple?: boolean;
  size?: number;
  options?: FakeNode[];
  selectedIndex?: number;
  labels?: FakeNode[];
  shadowRoot?: FakeRoot;
  isContentEditable = false;

  constructor(tagName: string, attrs: Attrs, ownText: string, ownerDocument: FakeRoot) {
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
    this.ownText = ownText;
    this.ownerDocument = ownerDocument;
  }

  get id(): string {
    return this.attrs.id ?? "";
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((one) => matchesSimple(this, one.trim()));
  }

  closest(selector: string): FakeNode | null {
    return ancestors(this).find((node) => node.matches(selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return descendants(this).filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getClientRects(): unknown[] {
    return ancestors(this).some((node) => node.display === "none" || (node.tagName === "DIALOG" && !node.open)) ? [] : [{}];
  }

  getRootNode(): FakeRoot {
    const chain = ancestors(this);
    const top = chain[chain.length - 1] ?? this;

    return top.parentNode instanceof FakeRoot ? top.parentNode : this.ownerDocument;
  }
}

function ancestors(node: FakeNode): FakeNode[] {
  const chain: FakeNode[] = [];

  for (let current: FakeNode | FakeRoot | null = node; current instanceof FakeNode; current = current.parentNode) chain.push(current);

  return chain;
}

class FakeRoot {
  nodeType: number;
  children: FakeNode[] = [];
  title = "Popup";
  readyState = "complete";
  defaultView = { getComputedStyle: (el: FakeNode) => ({ display: el.display || "block", visibility: "visible" }) };
  getAnimations?: () => unknown[];

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.children.flatMap((child) => [child, ...descendants(child)]).filter((node) => node.matches(selector));
  }

  getElementById(id: string): FakeNode | null {
    return this.querySelectorAll("*").find((node) => node.id === id) ?? null;
  }
}

function descendants(node: FakeNode): FakeNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function matchesSimple(node: FakeNode, selector: string): boolean {
  if (selector === "*") return true;
  if (selector.includes(" ")) return false;

  const match = /^([a-z0-9]*)(#[\w-]+)?((?:\[[^\]]*\])*)$/i.exec(selector);
  if (!match) return false;

  const [, tag, id, attrs] = match;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (id && node.id !== id.slice(1)) return false;

  for (const attr of attrs.match(/\[[^\]]*\]/g) ?? []) {
    const inner = attr.slice(1, -1);
    const eq = inner.indexOf("=");
    const name = eq === -1 ? inner : inner.slice(0, eq);
    if (!node.hasAttribute(name)) return false;
    if (eq === -1) continue;

    const wanted = inner.slice(eq + 1).replace(/^['"]|['"]$/g, "");
    if (node.getAttribute(name) !== wanted) return false;
  }

  return true;
}

function page(): { document: FakeRoot; el: (tag: string, attrs?: Attrs, text?: string, into?: FakeNode | FakeRoot) => FakeNode } {
  const document = new FakeRoot(9);

  const el = (tag: string, attrs: Attrs = {}, text = "", into: FakeNode | FakeRoot = document): FakeNode => {
    const node = new FakeNode(tag, attrs, text, document);

    node.parentNode = into;
    into.children.push(node);

    return node;
  };

  return { document, el };
}

const { elementListExpression, observeExpression, readElementList, readObservation, settleWaitWithin } = await import("../lib/element-list");

function listed(document: FakeRoot): Record<string, any> {
  return vm.runInNewContext(elementListExpression(), { document });
}

function popup(): { document: FakeRoot; body: FakeNode; el: ReturnType<typeof page>["el"] } {
  const { document, el } = page();
  const html = el("html");
  const body = el("body", {}, "", html);

  return { document, body, el };
}

describe("the element list a page answers", () => {
  it("lists the visible interactive elements with role, accessible name, a selector matching one element and their state", () => {
    const { document, body, el } = popup();
    el("h1", {}, "Settings", body);
    el("button", { id: "save" }, "Save", body);
    const name = el("input", { type: "text", name: "title", placeholder: "Title" }, "", body);
    name.value = "Hello";
    const agree = el("input", { type: "checkbox", id: "agree" }, "", body);
    agree.checked = true;
    agree.labels = [el("label", { for: "agree" }, "I agree", body)];
    el("a", { href: "/help" }, "Help", body);
    const off = el("button", {}, "Delete", body);
    off.disabled = true;
    const note = el("textarea", { "aria-label": "Note" }, "", body);
    note.readOnly = true;
    note.value = "";
    el("div", { role: "tab", "aria-selected": "true" }, "General", body);
    el("span", {}, "plain text", body);

    const snap = listed(document);

    expect(snap.elements).toEqual([
      { role: "heading", name: "Settings", selector: "html > body > h1", level: 1 },
      { role: "button", name: "Save", selector: "#save" },
      { role: "textbox", name: "Title", selector: 'input[name="title"]', value: "Hello" },
      { role: "checkbox", name: "I agree", selector: "#agree", checked: true },
      { role: "link", name: "Help", selector: "html > body > a" },
      { role: "button", name: "Delete", selector: "html > body > button:nth-of-type(2)", disabled: true },
      { role: "textbox", name: "Note", selector: 'textarea[aria-label="Note"]', readOnly: true, value: "" },
      { role: "tab", name: "General", selector: "html > body > div", selected: true },
    ]);

    expect(snap.elementCount).toBe(8);
    expect(snap.elementsTruncated).toBe(false);
    expect(readElementList(snap)).toEqual(snap);
    expect(JSON.stringify(snap).length).toBeLessThan(700);
  });

  it("skips hidden elements, collapses runs of identical ones, folds a select into one entry and caps the list", () => {
    const { document, body, el } = popup();
    const gone = el("button", {}, "Hidden", body);
    gone.display = "none";
    el("input", { type: "hidden", name: "token" }, "", body);
    el("button", { hidden: "" }, "Also hidden", body).hidden = true;
    el("div", { "aria-hidden": "true", role: "button" }, "Off tree", body);
    const closed = el("dialog", {}, "", body);
    el("button", {}, "Inside", closed);

    const list = el("ul", {}, "", body);
    for (let i = 0; i < 3; i++) el("button", { class: "row" }, "Remove", el("li", {}, "", list));

    const select = el("select", { name: "theme" }, "", body);
    select.options = [el("option", {}, "Light", select), el("option", {}, "Dark", select)];
    select.selectedIndex = 1;

    const box = el("div", { role: "listbox" }, "", body);
    for (const label of ["a", "b", "c"]) el("div", { role: "option" }, label, box);

    const snap = listed(document);

    expect(snap.elements).toEqual([
      { role: "button", name: "Remove", selector: "html > body > ul > li:nth-of-type(1) > button", count: 3 },
      { role: "combobox", name: "theme", selector: 'select[name="theme"]', options: 2, value: "Dark" },
      { role: "listbox", name: "abc", selector: "html > body > div:nth-of-type(2)", options: 3 },
    ]);

    expect(snap.elementCount).toBe(5);

    for (let i = 0; i < 250; i++) el("button", {}, `Pick ${i}`, body);
    const capped = listed(document);

    expect(capped.elements).toHaveLength(200);
    expect(capped.elementsTruncated).toBe(true);
    expect(capped.elementCount).toBe(255);
  });

  it("reaches into open shadow roots and names the host", () => {
    const { document, body, el } = popup();
    const host = el("x-card", { id: "card" }, "", body);
    const shadow = new FakeRoot(11);
    host.shadowRoot = shadow;
    const inner = new FakeNode("button", { id: "go" }, "Go", document);
    inner.parentNode = shadow;
    shadow.children.push(inner);

    expect(listed(document).elements).toEqual([{ role: "button", name: "Go", selector: "#go", host: "#card" }]);
  });

  it("refuses a value that is not a list", () => {
    expect([null, { elements: [{ role: "button" }] }].map(readElementList)).toEqual([null, null]);
    expect(readElementList({ elements: [] })).toEqual({ elements: [], elementCount: 0, elementsTruncated: false });
  });
});

describe("the observation a page answers once it settled", () => {
  function observed(document: FakeRoot, waitMs: number): Promise<Record<string, any>> {
    const window = { addEventListener: () => {} };

    return vm.runInNewContext(observeExpression(waitMs), {
      document,
      window,
      location: { href: "chrome-extension://abc/popup.html" },
      setTimeout,
    });
  }

  const animation = (iterations: number, finished: Promise<void>): unknown => ({ playState: "running", effect: { getComputedTiming: () => ({ iterations, endTime: 300 }) }, finished });

  it("answers settled: true with the list, url and title when the document is complete and nothing finite animates", async () => {
    const { document, body, el } = popup();
    el("button", { id: "ok" }, "OK", body);
    document.getAnimations = () => [animation(Infinity, new Promise(() => {}))];

    const snap = await observed(document, 100);

    expect(snap).toEqual({
      elements: [{ role: "button", name: "OK", selector: "#ok" }],
      elementCount: 1,
      elementsTruncated: false,
      settled: true,
      url: "chrome-extension://abc/popup.html",
      title: "Popup",
    });

    expect(readObservation(snap)).toEqual(snap);
  });

  it("waits for a finite animation to finish, and says settled: false when it outlives the wait", async () => {
    const { document } = popup();

    let done = () => {};

    let calls = 0;

    const finishing = new Promise<void>((resolve) => {
      done = resolve;
    });

    document.getAnimations = () => (calls++ === 0 ? [animation(1, finishing)] : []);
    setTimeout(done, 20);

    expect((await observed(document, 500)).settled).toBe(true);

    document.getAnimations = () => [animation(1, new Promise(() => {}))];
    const stuck = await observed(document, 60);

    expect(stuck.settled).toBe(false);
    expect(stuck.elements).toEqual([]);
  });

  it("says settled: false when the document never finishes loading within the wait", async () => {
    const { document } = popup();
    document.readyState = "loading";

    expect((await observed(document, 40)).settled).toBe(false);
  });

  it("bounds the settle wait by half the call timeout, within 50 ms and 5 s", () => {
    expect([undefined, 600, 20, 60_000].map(settleWaitWithin)).toEqual([1_500, 300, 50, 1_500]);
  });
});

const cdp = vi.hoisted(() => ({
  port: { port: 9222, source: "contract" as const } as { port: number; source: "contract" } | null,
  targets: [] as Array<{ id: string; type: string; url: string; title: string }>,
  evaluated: [] as Array<{ targetId: string; expression: string }>,
  answer: null as unknown,
}));

const rdp = vi.hoisted(() => ({
  port: 6000 as number | null,
  tabs: [] as RdpTab[],
  evaluated: [] as Array<{ url: string; expression: string }>,
  answer: null as unknown,
}));

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => cdp.port,
    resolveRdpPort: async () => (rdp.port === null ? null : { port: rdp.port, source: "contract" as const }),
  };
});

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdp.targets;
    }
  }

  return { CDPClient };
});

vi.mock("../lib/cdp-extension-page", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpExtensionPageModule>();

  return {
    ...actual,
    evaluateOnExtensionPage: async (_port: number, targetId: string, expression: string) => {
      cdp.evaluated.push({ targetId, expression });

      return cdp.answer === null ? { ok: false, message: "Inspected target navigated or closed", thrown: false } : { ok: true, value: cdp.answer };
    },
  };
});

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => rdp.tabs,
    rdpEvaluateInTab: async (_port: number, options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined; expression: string }) => {
      const picked = options.select(rdp.tabs);
      if (!picked) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };

      rdp.evaluated.push({ url: String(picked.url), expression: options.expression });

      return { ok: true, value: rdp.answer, tab: { url: String(picked.url), title: "" } };
    },
  };
});

const bridge = vi.hoisted(() => ({ tabs: [] as Array<{ tabId: number | null; url: string; title: string }> }));

vi.mock("../lib/bridge-tabs", () => ({ listBridgeTabs: async () => ({ tabs: bridge.tabs }) }));

const { attachObservation, observeAsked, readObservationOn, resolveObserveTarget } = await import("../lib/observe-surface");

const surfaces = {
  surfaceDocument: (_projectPath: string, _browser: string, surface: string) => (surface === "popup" ? "popup.html" : null),
  resolveExtensionId: async () => "abc",
};

const observation = {
  elements: [{ role: "button", name: "Save", selector: "#save" }],
  elementCount: 1,
  elementsTruncated: false,
  settled: true,
  url: "chrome-extension://abc/popup.html",
  title: "Popup",
};

afterEach(() => {
  cdp.port = { port: 9222, source: "contract" };
  cdp.targets = [];
  cdp.evaluated.length = 0;
  cdp.answer = null;
  rdp.port = 6000;
  rdp.tabs = [];
  rdp.evaluated.length = 0;
  rdp.answer = null;
  bridge.tabs = [];
});

describe("resolving what an act touched to a page the debug port can read", () => {
  it("finds a surface by its manifest document on the CDP target list and reads the observation on it", async () => {
    cdp.targets = [{ id: "pop", type: "page", url: "chrome-extension://abc/popup.html", title: "Popup" }];
    cdp.answer = observation;

    const target = await resolveObserveTarget({ projectPath: "/p", browser: "chrome", context: "popup" }, surfaces);
    expect(target).toEqual({ kind: "cdp", port: 9222, targetId: "pop", url: "chrome-extension://abc/popup.html", label: "the popup" });

    const read = await readObservationOn(target, 4_000);
    expect(read).toMatchObject({ observation, waitedMs: 1_500 });
    expect(cdp.evaluated[0].targetId).toBe("pop");
    expect(cdp.evaluated[0].expression).toContain("getAnimations");
  });

  it("finds a surface on the Firefox tab list by its document and reads it over RDP", async () => {
    rdp.tabs = [{ actor: "t1", url: "https://example.com/" }, { actor: "t2", url: "moz-extension://uuid/popup.html" }];
    rdp.answer = observation;

    const target = await resolveObserveTarget({ projectPath: "/p", browser: "firefox", context: "popup" }, surfaces);
    expect(target).toEqual({ kind: "rdp", port: 6000, url: "moz-extension://uuid/popup.html", label: "the popup" });

    const read = await readObservationOn(target);
    expect(read).toMatchObject({ observation });
    expect(rdp.evaluated[0].url).toBe("moz-extension://uuid/popup.html");
  });

  it("takes a targetId, a url or a chrome.tabs id as the page to read", async () => {
    cdp.targets = [
      { id: "one", type: "page", url: "https://example.com/a", title: "A" },
      { id: "two", type: "page", url: "https://example.com/b?x=1", title: "B" },
    ];

    bridge.tabs = [{ tabId: 7, url: "https://example.com/b?x=1", title: "B" }];

    const pick = { projectPath: "/p", browser: "chrome" };

    expect(await resolveObserveTarget({ ...pick, targetId: "two" }, surfaces)).toMatchObject({ kind: "cdp", targetId: "two" });
    expect(await resolveObserveTarget({ ...pick, url: "https://example.com/b" }, surfaces)).toMatchObject({ kind: "cdp", targetId: "two" });
    expect(await resolveObserveTarget({ ...pick, tab: 7 }, surfaces)).toMatchObject({ kind: "cdp", targetId: "two", label: "tab 7" });
    expect(await resolveObserveTarget({ ...pick, targetId: "gone" }, surfaces)).toMatchObject({ kind: "unavailable", reason: "no open page has targetId gone" });
  });

  it("says why when nothing can be read: no document, no open page, no port, no debug port on this browser", async () => {
    const pick = { projectPath: "/p", browser: "chrome" };

    expect(await resolveObserveTarget({ ...pick, context: "options" }, surfaces)).toMatchObject({ kind: "unavailable", reason: "the manifest declares no options document" });
    expect(await resolveObserveTarget({ ...pick, context: "popup" }, surfaces)).toMatchObject({ kind: "unavailable", reason: "no open page shows chrome-extension://abc/popup.html" });
    cdp.port = null;
    expect(await resolveObserveTarget({ ...pick, context: "popup" }, surfaces)).toMatchObject({ kind: "unavailable", reason: "the session records no CDP port" });
    expect(await resolveObserveTarget({ ...pick, browser: "safari", context: "popup" }, surfaces)).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("no debug port") });
    expect(await resolveObserveTarget(pick, surfaces)).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("names what to observe") });
  });

  it("attaches the observation to the act's answer, or observation: null with the reason and the snapshot call to make next", () => {
    const frame: Record<string, any> = { ok: true, value: { opened: true }, warnings: [] };
    const target = { kind: "cdp" as const, port: 9222, targetId: "pop", url: "chrome-extension://abc/popup.html", label: "the popup" };

    attachObservation(frame, { observation, waitedMs: 1_500, target }, "popup");
    expect(frame.value.observation).toEqual(observation);
    expect(frame.warnings).toEqual([]);

    attachObservation(frame, { observation: { ...observation, settled: false }, waitedMs: 1_500, target }, "popup");
    expect(frame.warnings[0]).toMatch(/observation\.settled is false: the popup was still loading or had finite animations running 1500 ms after the act/);
    expect(frame.warnings[0]).toContain('extension_dom_snapshot {targetId: "pop", include: ["elements"]}');

    const scalar: Record<string, any> = { ok: true, value: 5, warnings: [] };
    attachObservation(scalar, { unavailable: "no open page shows the popup", target: { kind: "unavailable", reason: "x", label: "the popup" } }, "popup");
    expect(scalar.value).toEqual({ result: 5, observation: null });
    expect(scalar.warnings[0]).toBe('observe: true could not read the popup: no open page shows the popup. Read it once it is open with extension_dom_snapshot {context: "popup", include: ["elements"]}.');
  });

  it("reads observe as off, on for the act's own surface, on for a named surface, or refused for a name that is no surface", () => {
    expect(observeAsked(undefined)).toEqual({ on: false });
    expect(observeAsked(false)).toEqual({ on: false });
    expect(observeAsked(true)).toEqual({ on: true });
    expect(observeAsked("options")).toEqual({ on: true, context: "options" });
    expect(observeAsked("background")).toMatchObject({ on: true, refused: expect.stringContaining('"background" is not a surface') });
  });
});
