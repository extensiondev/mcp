import vm from "node:vm";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

const calls: string[][] = [];
let respond: () => string = () => JSON.stringify({ ok: true });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);

      return respond();
    },
  };
});

let rdpPort: number | null = 9222;
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveRdpPort: async () =>
      rdpPort === null ? null : { port: rdpPort, source: "contract" as const },
  };
});

const rdpCalls: Array<{ expression: string; picked: RdpTab | null | undefined }> = [];
let openTabs: RdpTab[] = [];
let rdpFails = false;

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpEvaluateInTab: async (
      _port: number,
      options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined; expression: string },
    ) => {
      const picked = options.select(openTabs);
      rdpCalls.push({ expression: options.expression, picked });
      if (rdpFails) throw new Error("RDP connect timed out after 10000ms");
      if (!picked) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };

      return {
        ok: true,
        value: { context: "page", url: picked.url, title: "panel", summary: { htmlLength: 199 } },
        tab: { url: String(picked.url), title: "panel" },
      };
    },
  };
});

const domSnapshot = await import("../tools/dom-snapshot");

const PANEL = "moz-extension://1e5c8097-57a9-4052-bd54-d5d37a7086de/pages/panel.html";

/* @invariant Firefox's own answer to an injection into a page inside the extension,
   whatever host permissions the manifest holds. */
const missingHostPermission = () =>
  envelope({
    ok: false,
    command: "extension_dom_snapshot",
    status: "not-found",
    error: {
      code: "E_TARGET_NOT_FOUND",
      name: "TargetNotFound",
      message: "Missing host permission for the tab",
      engine: "firefox",
    },
  });

afterEach(() => {
  calls.length = 0;
  rdpCalls.length = 0;
  openTabs = [];
  rdpPort = 9222;
  rdpFails = false;
  respond = () => JSON.stringify({ ok: true });
});

describe("dom_snapshot of a page inside the extension on Gecko", () => {
  it("reads the page over the debugger protocol when the bridge cannot inject into it", async () => {
    respond = missingHostPermission;
    openTabs = [
      { actor: "tab1", url: "https://example.com/", title: "Example" },
      { actor: "tab2", url: PANEL, title: "panel" },
    ];

    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", browser: "firefox", url: PANEL }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.url).toBe(PANEL);
    expect(result.value.summary.htmlLength).toBe(199);
    expect(rdpCalls[0].picked?.actor).toBe("tab2");
    expect(result.warnings.join(" ")).toContain("debugger protocol");
  });

  it("asks for the html only when the caller did", async () => {
    respond = missingHostPermission;
    openTabs = [{ actor: "tab2", url: PANEL, title: "panel" }];

    await domSnapshot.handler({ projectPath: "/p", browser: "firefox", url: PANEL });
    await domSnapshot.handler({
      projectPath: "/p",
      browser: "firefox",
      url: PANEL,
      include: ["summary", "html"],
      maxBytes: 4096,
    });

    expect(rdpCalls[0].expression).toContain("if (false)");
    expect(rdpCalls[1].expression).toContain("if (true)");
    expect(rdpCalls[1].expression).toContain("var cap = 4096;");
  });

  it("keeps the engine's refusal when no tab shows the page, the port is absent, or the protocol fails", async () => {
    respond = missingHostPermission;

    const noTab = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", browser: "firefox", url: PANEL }),
    );
    rdpPort = null;
    const noPort = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", browser: "firefox", url: PANEL }),
    );
    rdpPort = 9222;
    rdpFails = true;
    openTabs = [{ actor: "tab2", url: PANEL, title: "panel" }];
    const failed = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", browser: "firefox", url: PANEL }),
    );

    for (const result of [noTab, noPort, failed]) {
      expect(result.ok).toBe(false);
      expect(result.error.message).toBe("Missing host permission for the tab");
    }
  });

  it("leaves a web page and a snapshot the bridge answered alone", async () => {
    respond = missingHostPermission;
    await domSnapshot.handler({
      projectPath: "/p",
      browser: "firefox",
      url: "https://example.com/",
    });

    respond = () => JSON.stringify({ ok: true, value: { url: PANEL } });
    await domSnapshot.handler({ projectPath: "/p", browser: "firefox", url: PANEL });

    expect(rdpCalls).toHaveLength(0);
  });

  it("does not take the protocol on Chromium", async () => {
    respond = missingHostPermission;
    await domSnapshot.handler({
      projectPath: "/p",
      browser: "chrome",
      url: "chrome-extension://abc/pages/panel.html",
    });

    expect(rdpCalls).toHaveLength(0);
  });
});

describe("the snapshot built over the protocol", () => {
  const html = '<html><head><title>panel</title></head><body><div id="extension-root"></div></body></html>';
  const fakeDocument = {
    title: "panel",
    documentElement: { outerHTML: html },
    body: { children: [1] },
    querySelectorAll: (selector: string) =>
      selector === "*" ? [] : selector.startsWith("#extension-root") ? [1] : [],
  };

  it("carries the fields the engine's own snapshot carries", () => {
    const snap = vm.runInNewContext(domSnapshot.protocolSnapshotExpression(false, 262144), {
      document: fakeDocument,
      location: { href: "moz-extension://uuid/pages/panel.html" },
    });

    expect(Object.keys(snap)).toEqual(["context", "url", "title", "summary"]);
    expect(Object.keys(snap.summary)).toEqual([
      "htmlLength",
      "scriptCount",
      "styleCount",
      "extensionRootCount",
      "openShadowRoots",
      "bodyChildCount",
    ]);

    expect(snap.summary.htmlLength).toBe(html.length);
    expect(snap.summary.extensionRootCount).toBe(1);
  });

  it("caps the html and says so", () => {
    const snap = vm.runInNewContext(domSnapshot.protocolSnapshotExpression(true, 20), {
      document: fakeDocument,
      location: { href: "moz-extension://uuid/pages/panel.html" },
    });

    expect(snap.html).toBe(html.slice(0, 20));
    expect(snap.htmlTruncated).toBe(true);
  });
});
