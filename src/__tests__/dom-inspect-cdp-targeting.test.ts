import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// DevX fresh-eyes finding: dom_inspect targets pages, but nothing in the
// toolset exposed WHICH tab to point it at, and CDP targetIds vs chrome.tabs
// ids is a known trap. `tabUrl` targets by a URL substring resolved against
// the live CDP page targets (unique match or enumerate, never guess), and
// `listTargets` is the discovery path.

const calls: string[][] = [];
let actResponder: (cli: string[]) => string = () => JSON.stringify({ ok: true });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      return actResponder(cli);
    },
  };
});

let cdpPort: { port: number; source: string } | null = { port: 9222, source: "contract" };
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => cdpPort };
});

let cdpTargets: Array<{ id: string; type: string; url: string; title: string }> = [];
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
  }
  return { CDPClient };
});

const domInspect = await import("../tools/dom-inspect");
const { matchTargetsByUrl, filterPageTargets } = await import(
  "../lib/cdp-targets"
);

beforeEach(() => {
  actResponder = () => JSON.stringify({ ok: true });
  cdpPort = { port: 9222, source: "contract" };
  cdpTargets = [
    { id: "AAA1", type: "page", url: "https://example.com/", title: "Example Domain" },
    { id: "BBB2", type: "page", url: "https://developer.chrome.com/docs", title: "Chrome Docs" },
    { id: "CCC3", type: "service_worker", url: "chrome-extension://abc/sw.js", title: "SW" },
    { id: "DDD4", type: "page", url: "devtools://devtools/bundled/x.html", title: "DevTools" },
  ];
});

afterEach(() => {
  calls.length = 0;
});

describe("dom_inspect listTargets", () => {
  it("returns page targets with targetId/url/title/type and never shells out", async () => {
    const result = JSON.parse(
      await domInspect.handler({ projectPath: "/p", listTargets: true, browser: "chrome" }),
    );

    expect(result.ok).toBe(true);
    expect(result.targets).toEqual([
      { targetId: "AAA1", type: "page", url: "https://example.com/", title: "Example Domain" },
      { targetId: "BBB2", type: "page", url: "https://developer.chrome.com/docs", title: "Chrome Docs" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("carries the targetId-vs-chrome.tabs-id trap warning", async () => {
    const result = JSON.parse(
      await domInspect.handler({ projectPath: "/p", listTargets: true, browser: "chrome" }),
    );

    expect(result.note).toContain("NOT a chrome.tabs id");
    expect(result.note).toContain("listTabs: true");
  });

  it("says there is no session when no CDP port resolves", async () => {
    cdpPort = null;

    const result = JSON.parse(
      await domInspect.handler({ projectPath: "/p", listTargets: true, browser: "chrome" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSession");
    expect(calls).toHaveLength(0);
  });

  it("reports a missing Gecko session as NoSession with the rdpPort hint", async () => {
    // Gecko listTargets is paired via the RDP root actor now; with no live
    // session there is no rdpPort, and the error must say how to get one
    // instead of the old "Unsupported" refusal.
    const result = JSON.parse(
      await domInspect.handler({ projectPath: "/p", listTargets: true, browser: "firefox" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSession");
    expect(result.error.message).toContain("rdpPort");
    expect(calls).toHaveLength(0);
  });
});

describe("dom_inspect tabUrl targeting", () => {
  it("a unique substring match inspects that tab via its exact url", async () => {
    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "chrome",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com/");
    expect(calls[0]).not.toContain("--tab");
    expect(result.resolvedTarget).toEqual({
      targetId: "AAA1",
      type: "page",
      url: "https://example.com/",
      title: "Example Domain",
      matchedBy: "tabUrl",
    });
  });

  it("matches case-insensitively", async () => {
    await domInspect.handler({
      projectPath: "/p",
      tabUrl: "EXAMPLE.COM",
      browser: "chrome",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com/");
  });

  it("falls back to title matching only when no url matches", async () => {
    await domInspect.handler({
      projectPath: "/p",
      tabUrl: "example domain",
      browser: "chrome",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com/");
  });

  it("zero matches returns the available targets instead of inspecting", async () => {
    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "no-such-page",
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoMatchingTarget");
    expect(result.availableTargets).toHaveLength(2);
    expect(result.availableTargets[0]).toHaveProperty("targetId");
    expect(result.availableTargets[0]).toHaveProperty("url");
    expect(result.availableTargets[0]).toHaveProperty("title");
    expect(result.hint).toContain("tabUrl");
    expect(calls).toHaveLength(0);
  });

  it("several matches returns the matching set and refuses to guess", async () => {
    cdpTargets.push({
      id: "EEE5",
      type: "page",
      url: "https://example.com/other",
      title: "Other",
    });

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("AmbiguousTabUrl");
    expect(result.matchingTargets.map((t: { targetId: string }) => t.targetId)).toEqual([
      "AAA1",
      "EEE5",
    ]);
    expect(result.hint).toContain("Narrow");
    expect(calls).toHaveLength(0);
  });

  it("rejects tabUrl combined with another tab selector", async () => {
    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "example",
        tab: 7,
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("BadRequest");
    expect(calls).toHaveLength(0);
  });

  it("Gecko resolves tabUrl against the bridge tab list and inspects by numeric tab id", async () => {
    actResponder = (cli) =>
      cli.includes("--list-tabs")
        ? JSON.stringify({
            ok: true,
            tabs: [
              { tabId: 7, url: "https://example.com/", title: "Example Domain" },
              { tabId: 9, url: "https://other.dev/", title: "Other" },
            ],
          })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "firefox",
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--list-tabs");
    expect(calls[1][calls[1].indexOf("--tab") + 1]).toBe("7");
    expect(calls[1]).not.toContain("--url");
    expect(result.resolvedTarget).toEqual({
      tabId: 7,
      url: "https://example.com/",
      title: "Example Domain",
      matchedBy: "tabUrl",
    });
  });

  it("Gecko zero matches returns the available tabs instead of inspecting", async () => {
    actResponder = (cli) =>
      cli.includes("--list-tabs")
        ? JSON.stringify({
            ok: true,
            tabs: [{ tabId: 7, url: "https://example.com/", title: "Example" }],
          })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "no-such-page",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoMatchingTarget");
    expect(result.availableTabs).toEqual([
      { tabId: 7, url: "https://example.com/", title: "Example" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("Gecko several matches refuses to guess and returns tabIds to pick from", async () => {
    actResponder = (cli) =>
      cli.includes("--list-tabs")
        ? JSON.stringify({
            ok: true,
            tabs: [
              { tabId: 7, url: "https://example.com/", title: "Example" },
              { tabId: 9, url: "https://example.com/other", title: "Other" },
            ],
          })
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("AmbiguousTabUrl");
    expect(result.matchingTabs.map((t: { tabId: number }) => t.tabId)).toEqual([
      7, 9,
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("cdp-targets helpers", () => {
  it("filterPageTargets drops workers and devtools windows", () => {
    const pages = filterPageTargets(cdpTargets);

    expect(pages.map((t) => t.targetId)).toEqual(["AAA1", "BBB2"]);
    expect(pages[0]).not.toHaveProperty("id");
  });

  it("matchTargetsByUrl prefers url hits over title hits", () => {
    const pages = filterPageTargets([
      { id: "1", type: "page", url: "https://a.dev/docs", title: "docs home" },
      { id: "2", type: "page", url: "https://b.dev/", title: "All the docs" },
    ]);

    const matches = matchTargetsByUrl(pages, "docs");

    expect(matches.map((t) => t.targetId)).toEqual(["1"]);
  });
});
