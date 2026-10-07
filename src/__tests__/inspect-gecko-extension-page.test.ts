import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

const calls: string[][] = [];
let deepDomApi: boolean | null = null;
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);

      if (cli[0] === "eval" && deepDomApi !== null) {
        return envelope({
          ok: true,
          command: "extension_inspect",
          status: "ok",
          value: { frames: [{ api: deepDomApi, closed: [] }] },
        });
      }

      return envelope({
        ok: true,
        command: "extension_inspect",
        status: "ok",
        value: {
          meta: { url: "moz-extension://abc/chrome_url_overrides/newtab.html", title: "NT" },
          summary: { bodyChildCount: 3 },
        },
      });
    },
  };
});

const listed: Array<{ url: string; title: string; id: number }> = [];
const navigations: string[] = [];
vi.mock("../lib/bridge-tabs", () => ({
  listBridgeTabs: async () => ({ tabs: listed }),
  navigateToUrlViaBridge: async (_p: string, _b: string, url: string) => {
    navigations.push(url);

    return envelope({ ok: true, command: "extension_inspect", status: "navigated", value: {} });
  },
  resolveBridgeBaseUrl: async () => "moz-extension://abc/",
}));

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => null, resolveRdpPort: async () => null };
});

const inspect = await import("../tools/inspect");
const gecko = await import("../tools/inspect-gecko");

const dirs: string[] = [];

function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inspect-gecko-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));

  return dir;
}

const MANIFEST = {
  manifest_version: 2,
  name: "F",
  chrome_url_overrides: { newtab: "chrome_url_overrides/newtab.html" },
  sidebar_action: { default_panel: "sidebar/index.html" },
};

afterEach(() => {
  calls.length = 0;
  deepDomApi = null;
  listed.length = 0;
  navigations.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_inspect on Gecko reads a page inside the extension through its surface relay", () => {
  it("routes a declared override document to its surface context instead of a tab injection", async () => {
    const dir = project(MANIFEST);

    const result = JSON.parse(
      await inspect.handler({
        projectPath: dir,
        browser: "firefox",
        url: "chrome_url_overrides/newtab.html",
        include: ["summary"],
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const idx = calls[0].indexOf("--context");
    expect(calls[0][idx + 1]).toBe("newtab");
    expect(calls[0]).not.toContain("--url");
    expect(navigations).toEqual([]);
    expect(result.value.surface).toBe("newtab");
    expect(result.value.transport).toBe("bridge");
  });

  it("accepts the full moz-extension url and a bare document name", () => {
    const dir = project(MANIFEST);

    expect(
      gecko.surfaceForExtensionUrl(
        dir,
        "firefox",
        "moz-extension://20bc13c2-7ff4-4103-b112-0c7c6e67d612/chrome_url_overrides/newtab.html?x=1",
      ),
    ).toEqual({ context: "newtab", document: "chrome_url_overrides/newtab.html" });

    expect(gecko.surfaceForExtensionUrl(dir, "firefox", "newtab.html")).toEqual({
      context: "newtab",
      document: "chrome_url_overrides/newtab.html",
    });

    expect(gecko.surfaceForExtensionUrl(dir, "firefox", "sidebar/index.html")).toEqual({
      context: "sidebar",
      document: "sidebar/index.html",
    });

    expect(gecko.surfaceForExtensionUrl(dir, "firefox", "https://example.com/")).toBeNull();
  });

  it("names the declared surfaces when an extension url matches none of them", async () => {
    const dir = project(MANIFEST);

    const result = JSON.parse(
      await inspect.handler({
        projectPath: dir,
        browser: "firefox",
        url: "moz-extension://abc/pages/welcome.html",
        include: ["summary"],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(result.error.message).toContain("sidebar, newtab");
    expect(result.error.message).toContain("Script injection cannot reach");
    expect(calls).toEqual([]);
  });

  it("asks for probes in the same shape the Chromium path returns", async () => {
    const dir = project(MANIFEST);

    await inspect.handler({
      projectPath: dir,
      browser: "firefox",
      url: "chrome_url_overrides/newtab.html",
      include: ["summary"],
      probe: ["#ryd-bar-container", "dislike-button-view-model"],
    });

    const expression = calls[0][1];
    expect(expression).toContain("samples: els.slice(0, 3)");
    expect(expression).toContain("textSnippet");
    expect(expression).toContain('"#ryd-bar-container"');
    expect(expression).not.toContain("outerHTML || \"\").slice(0, 200)");
  });

  it("still inspects a web page by url through the page context", async () => {
    const dir = project(MANIFEST);
    listed.push({ url: "https://example.com/", title: "Example", id: 1 });

    await inspect.handler({
      projectPath: dir,
      browser: "firefox",
      url: "https://example.com/",
      include: ["summary"],
    });

    expect(calls).toHaveLength(1);
    const idx = calls[0].indexOf("--context");
    expect(calls[0][idx + 1]).toBe("page");
    expect(calls[0]).toContain("--url");
  });

describe("deepDom on Gecko says whether closed roots could be seen at all", () => {
  it("notes a context that cannot see closed roots instead of listing none", async () => {
    const dir = project(MANIFEST);
    deepDomApi = false;
    const out = JSON.parse(
      await inspect.handler({ projectPath: dir, browser: "firefox", url: "https://a.test/", deepDom: true, include: [] }),
    );
    expect(out.value.closedShadowRootsVisible).toBe(false);
    expect(out.warnings.join("\n")).toMatch(/could not be seen/);
  });

  it("reports visible closed roots plainly when the api is there", async () => {
    const dir = project(MANIFEST);
    deepDomApi = true;
    const out = JSON.parse(
      await inspect.handler({ projectPath: dir, browser: "firefox", url: "https://a.test/", deepDom: true, include: [] }),
    );
    expect(out.value.closedShadowRootsVisible).toBe(true);
    expect(out.warnings.join("\n")).not.toMatch(/could not be seen/);
  });
});
});
