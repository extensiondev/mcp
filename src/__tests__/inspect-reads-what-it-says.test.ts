/* @invariant the inspect envelope names the document it
 * read, a throw is a failed section and never an empty value, an uncaught
 * exception counts as a console error, and every cap is said. Each cell
 * failed before its fix. */

import { describe, expect, it, vi, beforeEach } from "vitest";

const cdp = vi.hoisted(() => ({
  targets: [] as Array<{ id: string; type: string; url: string; title: string }>,
  navigateThrows: null as string | null,
  landOn: null as string | null,
  metaThrows: null as string | null,
  domSnapshot: { nodes: [{ tag: "html", depth: 0 }], truncated: false, totalElements: 1 } as unknown,
}));

vi.mock("../lib/cdp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp")>();
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
      async navigate(_sessionId: string, url: string) {
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
        return "<html></html>";
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
      async getClosedShadowRoots() {
        return [];
      }
      disconnect() {}
    },
  };
});

vi.mock("../lib/cdp-port", () => ({
  resolveCdpPort: async () => ({ port: 9222 }),
  CDP_PORT_MISSING_HINT: "",
}));

const { handler } = await import("../tools/inspect");
const { normalizeDomSnapshot } = await import("../lib/cdp");
const { CDPConnection } = await import("../lib/cdp-connection");
const scripts = await import("../lib/cdp-page-scripts");

beforeEach(() => {
  cdp.targets = [{ id: "web", type: "page", url: "https://site.test/", title: "site" }];
  cdp.navigateThrows = null;
  cdp.landOn = null;
  cdp.metaThrows = null;
  cdp.domSnapshot = { nodes: [{ tag: "html", depth: 0 }], truncated: false, totalElements: 1 };
});

describe("71a: the envelope names the document that was read", () => {
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

describe("71c: a section that threw is named, never emptied", () => {
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
    const { CDPClient } = await vi.importActual<typeof import("../lib/cdp")>("../lib/cdp");
    const client = new CDPClient();
    (client as unknown as { sendCommand: unknown }).sendCommand = async () => ({
      result: { type: "object", subtype: "error" },
      exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } },
    });
    await expect(client.evaluate("s", "nope")).rejects.toThrow(/ReferenceError: nope is not defined/);
  });
});

describe("71b: an uncaught exception is a console error", () => {
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

describe("71d: every cap is said", () => {
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
