import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { actFrame, tabRows } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as CdpExtensionPageModule from "../lib/cdp-extension-page";


const calls: string[][] = [];
let actResponder: (cli: string[]) => string = () => JSON.stringify({ ok: true });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

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
  const actual = await importOriginal<typeof CdpPortModule>();

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

const pageReads: Array<{ targetId: string; expression: string }> = [];
const elementsAnswer = { elements: [{ role: "button", name: "Save", selector: "#save" }], elementCount: 1, elementsTruncated: false };
let pageAnswer: Record<string, unknown> | null = null;
vi.mock("../lib/cdp-extension-page", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpExtensionPageModule>();

  return {
    ...actual,
    evaluateOnExtensionPage: async (_port: number, targetId: string, expression: string) => {
      pageReads.push({ targetId, expression });

      return { ok: true, value: pageAnswer ?? elementsAnswer };
    },
  };
});

const domSnapshot = await import("../tools/dom-snapshot");
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
  pageReads.length = 0;
  pageAnswer = null;
});

describe("dom_snapshot listTargets", () => {
  it("returns page targets with targetId/url/title/type and never shells out", async () => {
    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", listTargets: true, browser: "chrome" }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("listed-targets");
    expect(result.value.targets).toEqual([
      { targetId: "AAA1", type: "page", url: "https://example.com/", title: "Example Domain" },
      { targetId: "BBB2", type: "page", url: "https://developer.chrome.com/docs", title: "Chrome Docs" },
    ]);

    expect(calls).toHaveLength(0);
  });

  it("carries the targetId-vs-chrome.tabs-id trap warning", async () => {
    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", listTargets: true, browser: "chrome" }),
    );

    expect(result.warnings[0]).toContain("NOT a chrome.tabs id");
    expect(result.warnings[0]).toContain("listTabs: true");
  });

  it("says there is no session when no CDP port resolves", async () => {
    cdpPort = null;

    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", listTargets: true, browser: "chrome" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSession");
    expect(calls).toHaveLength(0);
  });

  it("reports a missing Gecko session as NoSession with the rdpPort hint", async () => {
    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", listTargets: true, browser: "firefox" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSession");
    expect(result.error.message).toContain("rdpPort");
    expect(calls).toHaveLength(0);
  });
});

describe("dom_snapshot tabUrl targeting", () => {
  it("a unique substring match inspects that tab via its exact url", async () => {
    const result = JSON.parse(
      await domSnapshot.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "chrome",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com/");
    expect(calls[0]).not.toContain("--tab");
    expect(result.value.resolvedTarget).toEqual({
      targetId: "AAA1",
      type: "page",
      url: "https://example.com/",
      title: "Example Domain",
      matchedBy: "tabUrl",
    });
  });

  it("matches case-insensitively", async () => {
    await domSnapshot.handler({
      projectPath: "/p",
      tabUrl: "EXAMPLE.COM",
      browser: "chrome",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com/");
  });

  it("falls back to title matching only when no url matches", async () => {
    await domSnapshot.handler({
      projectPath: "/p",
      tabUrl: "example domain",
      browser: "chrome",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--url") + 1]).toBe("https://example.com/");
  });

  it("zero matches returns the available targets instead of inspecting", async () => {
    const result = JSON.parse(
      await domSnapshot.handler({
        projectPath: "/p",
        tabUrl: "no-such-page",
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoMatchingTarget");
    expect(result.error.code).toBe("E_NO_MATCHING_TARGET");
    expect(result.status).toBe("no-matching-target");
    expect(result.value.availableTargets).toHaveLength(2);
    expect(result.value.availableTargets[0]).toHaveProperty("targetId");
    expect(result.value.availableTargets[0]).toHaveProperty("url");
    expect(result.value.availableTargets[0]).toHaveProperty("title");
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
      await domSnapshot.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("AmbiguousTabUrl");
    expect(result.status).toBe("ambiguous-target");
    expect(result.value.matchingTargets.map((t: { targetId: string }) => t.targetId)).toEqual([
      "AAA1",
      "EEE5",
    ]);

    expect(result.hint).toContain("targetId");
    expect(calls).toHaveLength(0);
  });

  it("rejects tabUrl combined with another tab selector", async () => {
    const result = JSON.parse(
      await domSnapshot.handler({
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
        ? JSON.stringify(
            actFrame("inspect", tabRows([
              { id: 7, url: "https://example.com/", title: "Example Domain" },
              { id: 9, url: "https://other.dev/", title: "Other" },
            ])),
          )
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await domSnapshot.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "firefox",
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--list-tabs");
    expect(calls[1][calls[1].indexOf("--tab") + 1]).toBe("7");
    expect(calls[1]).not.toContain("--url");
    expect(result.value.resolvedTarget).toEqual({
      tabId: 7,
      url: "https://example.com/",
      title: "Example Domain",
      active: true,
      matchedBy: "tabUrl",
    });
  });

  it("Gecko zero matches returns the available tabs instead of inspecting", async () => {
    actResponder = (cli) =>
      cli.includes("--list-tabs")
        ? JSON.stringify(
            actFrame("inspect", tabRows([{ id: 7, url: "https://example.com/", title: "Example" }])),
          )
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await domSnapshot.handler({
        projectPath: "/p",
        tabUrl: "no-such-page",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoMatchingTarget");
    expect(result.value.availableTabs).toEqual([
      { tabId: 7, url: "https://example.com/", title: "Example", active: true },
    ]);

    expect(calls).toHaveLength(1);
  });

  it("Gecko several matches refuses to guess and returns tabIds to pick from", async () => {
    actResponder = (cli) =>
      cli.includes("--list-tabs")
        ? JSON.stringify(
            actFrame("inspect", tabRows([
              { id: 7, url: "https://example.com/", title: "Example" },
              { id: 9, url: "https://example.com/other", title: "Other" },
            ])),
          )
        : JSON.stringify({ ok: true });

    const result = JSON.parse(
      await domSnapshot.handler({
        projectPath: "/p",
        tabUrl: "example.com",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("AmbiguousTabUrl");
    expect(result.value.matchingTabs.map((t: { tabId: number }) => t.tabId)).toEqual([
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

  describe("matchTargetsByUrl reads a needle with * as a glob over the whole url", () => {
    const pages = filterPageTargets([
      { id: "yt", type: "page", url: "https://www.youtube.com/watch?v=05ny1bmo-Kk&t=1260s", title: "Match of the day" },
      { id: "other", type: "page", url: "https://www.youtube.com/watch?v=zzz", title: "Other clip" },
      { id: "plain", type: "page", url: "https://example.com/", title: "Example Domain" },
    ]);

    it("spans the query string, and ? in the glob is literal", () => {
      expect(matchTargetsByUrl(pages, "https://www.youtube.com/watch?v=05ny1bmo-Kk*").map((t) => t.targetId)).toEqual(["yt"]);
      expect(matchTargetsByUrl(pages, "https://www.youtube.com/watch?v=05ny1bmo-Kk").map((t) => t.targetId)).toEqual(["yt"]);
      expect(matchTargetsByUrl(pages, "*youtube.com/watch?v=*").map((t) => t.targetId)).toEqual(["yt", "other"]);
      expect(matchTargetsByUrl(pages, "https://www.youtube.com/watchXv=05ny1bmo-Kk*")).toEqual([]);
    });

    it("anchors the glob, so a run of literal characters alone matches nothing", () => {
      expect(matchTargetsByUrl(pages, "youtube.com/watch?v=05ny1bmo-Kk*")).toEqual([]);
      expect(matchTargetsByUrl(pages, "https://www.youtube.com/watch?v=05ny1bmo-Kk*&nothere")).toEqual([]);
      expect(matchTargetsByUrl(pages, "*.example.com/*")).toEqual([]);
    });

    it("keeps a needle without * as a case-insensitive substring", () => {
      expect(matchTargetsByUrl(pages, "YOUTUBE.COM/WATCH").map((t) => t.targetId)).toEqual(["yt", "other"]);
      expect(matchTargetsByUrl(pages, "v=05ny1bmo-Kk&t=1260s").map((t) => t.targetId)).toEqual(["yt"]);
    });

    it("falls back to the title with the same glob reading", () => {
      expect(matchTargetsByUrl(pages, "match of the*").map((t) => t.targetId)).toEqual(["yt"]);
      expect(matchTargetsByUrl(pages, "*of the day").map((t) => t.targetId)).toEqual(["yt"]);
      expect(matchTargetsByUrl(pages, "of the*")).toEqual([]);
    });
  });
});

describe("dom_snapshot include elements on the bridge path", () => {
  it("keeps elements away from the engine's inspect verb and reads the list over CDP on the page the engine answered", async () => {
    actResponder = () => JSON.stringify({ ok: true, value: { context: "page", url: "https://example.com/", summary: { htmlLength: 10 } } });

    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", url: "https://example.com/", include: ["elements"], browser: "chrome" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].indexOf("--include") + 1]).toBe("summary");
    expect(calls[0]).not.toContain("elements");
    expect(pageReads).toEqual([{ targetId: "AAA1", expression: expect.stringContaining("elementsTruncated") }]);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ url: "https://example.com/", summary: { htmlLength: 10 }, ...elementsAnswer });
    expect(result.warnings.join(" ")).toContain("selector that matches exactly one element");
  });

  it("answers elements: null with the reason and the snapshot call to make when no debug port can read the page", async () => {
    cdpPort = null;
    actResponder = () => JSON.stringify({ ok: true, value: { context: "page", url: "https://example.com/", summary: { htmlLength: 10 } } });

    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: "/p", url: "https://example.com/", include: ["summary", "elements"], browser: "chrome" }),
    );

    expect(calls[0][calls[0].indexOf("--include") + 1]).toBe("summary");
    expect(pageReads).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.value.elements).toBeNull();
    expect(result.value.summary).toEqual({ htmlLength: 10 });
    expect(result.warnings.join(" ")).toMatch(/could not be read over the debug port for https:\/\/example\.com\/: the session records no CDP port/);
    expect(result.warnings.join(" ")).toContain('extension_dom_snapshot {include: ["elements"]}');
  });
});

describe("938: the html a snapshot answers is capped where a client can read it", () => {
  const LONG_PAGE = `<html><body><ul>${"<li>calibrate sensor 7</li>".repeat(9_979)}</ul></body></html>`;
  const summary = () => ({ htmlLength: LONG_PAGE.length, scriptCount: 2, styleCount: 3, extensionRootCount: 0, openShadowRoots: 0, bodyChildCount: 1 });

  it("cuts a long page read by targetId at the default cap and says the size and how to read less", async () => {
    pageAnswer = { context: "page", url: "https://example.com/", title: "Example Domain", summary: summary(), html: LONG_PAGE };

    const raw = await domSnapshot.handler({ projectPath: "/p", browser: "chrome", targetId: "AAA1", include: ["html"] });
    const result = JSON.parse(raw);

    expect(LONG_PAGE.length).toBeGreaterThan(259_000);
    expect(domSnapshot.schema.inputSchema.properties.maxBytes.default).toBe(32_768);
    expect(pageReads[0]!.expression).toContain("var cap = 32768;");
    expect(result.ok).toBe(true);
    expect(result.value.html).toBe(LONG_PAGE.slice(0, 32_768));
    expect(result.value.htmlTruncated).toBe(true);
    expect(result.value.summary.htmlLength).toBe(LONG_PAGE.length);
    expect(result.hint).toContain(`value.html is the first 32768 of ${LONG_PAGE.length} characters`);
    expect(result.hint).toContain('include: ["elements"]');
    expect(result.hint).toContain(`maxBytes, up to ${LONG_PAGE.length}`);
    expect(raw.length).toBeLessThan(40_000);
  });

  it("sends the cap to the engine and cuts an engine answer that came back over it", async () => {
    actResponder = () => JSON.stringify(actFrame("inspect", { context: "page", url: "https://example.com/", summary: summary(), html: LONG_PAGE }));

    const result = JSON.parse(await domSnapshot.handler({ projectPath: "/p", browser: "chrome", url: "https://example.com/", context: "page", include: ["html"] }));
    const cli = calls[calls.length - 1]!;

    expect(cli[cli.indexOf("--max-bytes") + 1]).toBe("32768");
    expect(result.value.html).toHaveLength(32_768);
    expect(result.value.htmlTruncated).toBe(true);
    expect(result.value.summary.htmlLength).toBe(LONG_PAGE.length);
    expect(result.hint).toContain("value.htmlTruncated");
  });

  it("gives the hint to an answer the engine cut itself, and leaves a page under the cap as it was", async () => {
    actResponder = () => JSON.stringify(actFrame("inspect", { context: "page", url: "https://example.com/", summary: summary(), html: LONG_PAGE.slice(0, 500), htmlTruncated: true }));

    const cut = JSON.parse(await domSnapshot.handler({ projectPath: "/p", browser: "chrome", url: "https://example.com/", context: "page", include: ["html"], maxBytes: 500 }));

    expect(calls[calls.length - 1]).toContain("500");
    expect(cut.value.html).toHaveLength(500);
    expect(cut.hint).toContain(`value.html is the first 500 of ${LONG_PAGE.length} characters`);

    pageAnswer = { context: "page", url: "https://example.com/", title: "Example Domain", summary: { ...summary(), htmlLength: 26 }, html: "<html><body></body></html>" };

    const whole = JSON.parse(await domSnapshot.handler({ projectPath: "/p", browser: "chrome", targetId: "AAA1", include: ["html"] }));

    expect(whole.value.html).toBe("<html><body></body></html>");
    expect(whole.value.htmlTruncated).toBeUndefined();
    expect(whole.hint).toBeUndefined();

    pageAnswer = { context: "page", url: "https://example.com/", title: "Example Domain", summary: summary(), html: LONG_PAGE };

    const asked = JSON.parse(await domSnapshot.handler({ projectPath: "/p", browser: "chrome", targetId: "AAA1", include: ["html"], maxBytes: 300_000 }));

    expect(asked.value.html).toHaveLength(LONG_PAGE.length);
    expect(asked.value.htmlTruncated).toBeUndefined();
  });
});
