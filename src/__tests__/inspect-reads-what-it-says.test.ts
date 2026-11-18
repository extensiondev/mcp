import { describe, expect, it, vi, beforeEach } from "vitest";

import type * as CdpModule from "../lib/cdp";

const cdp = vi.hoisted(() => ({
  order: [] as string[],
  targets: [] as Array<{ id: string; type: string; url: string; title: string }>,
  navigateThrows: null as string | null,
  landOn: null as string | null,
  metaThrows: null as string | null,
  domSnapshot: { nodes: [{ tag: "html", depth: 0 }], truncated: false, totalElements: 1 } as unknown,
  html: "<html></html>",
  closedRoots: [] as Array<{ host: string; type: string; html: string; truncated?: boolean }>,
  closedRootsCap: 0,
}));

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpModule>();

  return {
    ...actual,
    CDPClient: class {
      static async discoverTargets() {
        return cdp.targets;
      }
      static async discoverBrowserWsUrl() {
        return "ws://127.0.0.1:1/browser";
      }
      async connect() {}
      async attachToTarget(id: string) {
        return `session-${id}`;
      }
      async enableDomains() {}
      resetConsole() {
        cdp.order.push("resetConsole");
      }
      async navigate(_sessionId: string, url: string) {
        cdp.order.push("navigate");
        if (cdp.navigateThrows) throw new Error(cdp.navigateThrows);

        const landed = cdp.landOn ?? url;
        cdp.targets = cdp.targets.map((t) => (t.id === "web" ? { ...t, url: landed, title: "Landed" } : t));
      }
      async evaluate() {
        return {};
      }
      async getPageMeta() {
        if (cdp.metaThrows) throw new Error(cdp.metaThrows);

        return { url: "x" };
      }
      getConsoleSummary() {
        return { total: 0 };
      }
      async getPageHTML() {
        return cdp.html;
      }
      async getDomSnapshot() {
        return cdp.domSnapshot;
      }
      async getExtensionRootMeta() {
        return null;
      }
      async probeSelectors() {
        return [];
      }
      async getClosedShadowRoots(_sessionId: string, maxBytes: number) {
        cdp.closedRootsCap = maxBytes;

        return cdp.closedRoots;
      }
      disconnect() {}
    },
  };
});

vi.mock("../lib/cdp-port", () => ({
  resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }),
  CDP_PORT_MISSING_HINT: "",
}));

const { handler, schema } = await import("../tools/inspect");
const { schema: snapshotSchema } = await import("../tools/dom-snapshot");
const { HTML_DEFAULT_MAX_BYTES } = await import("../lib/html-cap");
const { normalizeDomSnapshot } = await import("../lib/cdp");
const { CDPConnection } = await import("../lib/cdp-connection");
const scripts = await import("../lib/cdp-page-scripts");

beforeEach(() => {
  cdp.order = [];
  cdp.targets = [{ id: "web", type: "page", url: "https://site.test/", title: "site" }];
  cdp.navigateThrows = null;
  cdp.landOn = null;
  cdp.metaThrows = null;
  cdp.domSnapshot = { nodes: [{ tag: "html", depth: 0 }], truncated: false, totalElements: 1 };
  cdp.html = "<html></html>";
  cdp.closedRoots = [];
  cdp.closedRootsCap = 0;
});

describe("the envelope names the document that was read", () => {
  it("reports the landed url and title after navigating, with the requested url beside it", async () => {
    const out = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", url: "https://other.test/", include: [] }));
    expect(out.ok).toBe(true);
    expect(out.value.target.url).toBe("https://other.test/");
    expect(out.value.target.title).toBe("Landed");
    expect(out.value.target.requestedUrl).toBe("https://other.test/");
  }, 10_000);

  it("says when the tab shows something other than the requested url", async () => {
    cdp.landOn = "chrome-error://chromewebdata/";
    const out = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", url: "https://other.test/", include: [] }));
    expect(out.value.target.url).toBe("chrome-error://chromewebdata/");
    expect(out.warnings.join("\n")).toMatch(/landed on its own error page/);
  }, 10_000);

  it("answers navigate-failed when the browser refused the url", async () => {
    cdp.navigateThrows = "The browser refused to navigate to https://other.test/: net::ERR_NAME_NOT_RESOLVED";
    const out = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", url: "https://other.test/", include: ["html"] }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("navigate-failed");
    expect(out.error.message).toMatch(/ERR_NAME_NOT_RESOLVED.*Nothing was inspected/);
    expect(out.value.html).toBeUndefined();
  });
});

describe("a navigating inspect reads the new document's console only", () => {
  it("drops the previous document's console before navigating", async () => {
    await handler({ projectPath: "/p", browser: "chrome", url: "https://other.test/", include: ["console"] });
    expect(cdp.order).toEqual(["resetConsole", "navigate"]);
  }, 10_000);

  it("keeps the console when no navigation happens", async () => {
    await handler({ projectPath: "/p", browser: "chrome", include: ["console"] });
    expect(cdp.order).toEqual([]);
  });
});

describe("a section that threw is named, never emptied", () => {
  it("answers inspected-partially with the failed section and a null value", async () => {
    cdp.metaThrows = "the page threw while evaluating: TypeError: x is not a function";
    const out = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", include: ["meta", "html"] }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("inspected-partially");
    expect(out.value.meta).toBeNull();
    expect(out.value.html).toBe("<html></html>");
    expect(out.value.failedSections).toEqual([{ section: "meta", reason: expect.stringMatching(/x is not a function/) }]);
    expect(out.warnings.join("\n")).toMatch(/meta could not be read/);
  });

  it("the CDP client throws on exceptionDetails instead of answering undefined", async () => {
    const { CDPClient } = await vi.importActual<typeof CdpModule>("../lib/cdp");
    const client = new CDPClient();
    (client as unknown as { sendCommand: unknown }).sendCommand = async () => ({
      result: { type: "object", subtype: "error" },
      exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } },
    });

    await expect(client.evaluate("s", "nope")).rejects.toThrow(/ReferenceError: nope is not defined/);
  });
});

describe("an uncaught exception is a console error", () => {
  it("counts Runtime.exceptionThrown in the summary", () => {
    const conn = new CDPConnection();
    (conn as unknown as { handleMessage: (data: string) => void }).handleMessage(
      JSON.stringify({
        method: "Runtime.exceptionThrown",
        params: {
          timestamp: 1,
          exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom at load" } },
        },
      }),
    );

    const summary = conn.getConsoleSummary() as { total: number; counts: Record<string, number>; topMessages: Array<{ text: string }> };
    expect(summary.total).toBe(1);
    expect(summary.counts.error).toBe(1);
    expect(summary.topMessages[0].text).toMatch(/TypeError: boom at load/);
  });
});

describe("every cap is said", () => {
  const LONG_PAGE = `<html><body><ul>${"<li>calibrate sensor 7</li>".repeat(9_979)}</ul></body></html>`;

  it("939: cuts the html at the default cap the snapshot tool uses and says the size and how to read less", async () => {
    cdp.html = LONG_PAGE;

    const raw = await handler({ projectPath: "/p", browser: "chrome", include: ["html"] });
    const out = JSON.parse(raw);

    expect(LONG_PAGE.length).toBeGreaterThan(259_000);
    expect(schema.inputSchema.properties.maxBytes.default).toBe(HTML_DEFAULT_MAX_BYTES);
    expect(snapshotSchema.inputSchema.properties.maxBytes.default).toBe(HTML_DEFAULT_MAX_BYTES);
    expect(HTML_DEFAULT_MAX_BYTES).toBe(32_768);
    expect(out.value.html).toBe(LONG_PAGE.slice(0, 32_768));
    expect(out.value.htmlTruncated).toBe(true);
    expect(out.value.summary).toEqual({ htmlLength: LONG_PAGE.length });
    expect(out.hint).toContain(`value.html is the first 32768 of ${LONG_PAGE.length} characters`);
    expect(out.hint).toContain("pass probe with the CSS selectors");
    expect(out.hint).toContain('include: ["dom_snapshot"]');
    expect(out.hint).toContain(`maxBytes, up to ${LONG_PAGE.length}`);
    expect(raw.length).toBeLessThan(40_000);
  });

  it("939: leaves a page under the cap as it was, and honors maxBytes with 0 as no cap", async () => {
    const small = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", include: ["html"] }));

    expect(small.value.html).toBe("<html></html>");
    expect(small.value.htmlTruncated).toBeUndefined();
    expect(small.value.summary).toBeUndefined();
    expect(small.hint).toBeUndefined();

    cdp.html = LONG_PAGE;

    const whole = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", include: ["html"], maxBytes: 0 }));
    const cut = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", include: ["html", "summary"], maxBytes: 500 }));

    expect(whole.value.html).toHaveLength(LONG_PAGE.length);
    expect(whole.value.htmlTruncated).toBeUndefined();
    expect(cut.value.html).toHaveLength(500);
    expect(cut.value.summary.htmlLength).toBe(LONG_PAGE.length);
    expect(cut.hint).toContain(`value.html is the first 500 of ${LONG_PAGE.length} characters`);
  });

  it("939: closed shadow roots share one cap between them, each cut one marked truncated", async () => {
    cdp.closedRoots = Array.from({ length: 40 }, (_, i) => ({ host: `x-card-${i}`, type: "closed", html: "<p>calibrate</p>".repeat(1_250) }));

    const out = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", include: [], deepDom: true }));
    const roots = out.value.closedShadowRoots as Array<{ html: string; truncated?: boolean }>;

    expect(cdp.closedRootsCap).toBe(32_768);
    expect(roots).toHaveLength(40);
    expect(roots.reduce((sum, root) => sum + root.html.length, 0)).toBe(32_768);
    expect(roots[0]).toMatchObject({ html: "<p>calibrate</p>".repeat(1_250) });
    expect(roots[0]!.truncated).toBeUndefined();
    expect(roots[1]).toMatchObject({ truncated: true });
    expect(roots[39]).toMatchObject({ html: "", truncated: true });
  });

  it("marks a truncated dom snapshot with the counts", async () => {
    cdp.domSnapshot = { nodes: Array.from({ length: 500 }, () => ({ tag: "div" })), truncated: true, totalElements: 1234 };
    const out = JSON.parse(await handler({ projectPath: "/p", browser: "chrome", include: ["dom_snapshot"] }));
    expect(out.value.domSnapshot).toHaveLength(500);
    expect(out.value.domSnapshotTruncated).toEqual({ listed: 500, totalElements: 1234, maxNodes: 500, maxDepth: 20 });
  });

  it("normalizes a bare array as untruncated and an object as what it says", () => {
    expect(normalizeDomSnapshot([{ tag: "a" }], 500)).toMatchObject({ truncated: false, totalElements: 1 });
    expect(normalizeDomSnapshot({ nodes: [], truncated: true, totalElements: 9 }, 500)).toMatchObject({ truncated: true, totalElements: 9 });
  });

  it("the page scripts count before they cut", () => {
    expect(scripts.domSnapshotScript(500)).toMatch(/truncated = true/);
    expect(scripts.domSnapshotScript(500)).toMatch(/totalElements: document\.getElementsByTagName\('\*'\)\.length/);
    expect(scripts.EXTENSION_ROOT_META_SCRIPT).toMatch(/rootCount: allRoots\.length/);
    expect(scripts.EXTENSION_ROOT_META_SCRIPT).toMatch(/truncated: allRoots\.length > roots\.length/);
  });
});
