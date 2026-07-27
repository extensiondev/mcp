import { describe, expect, it, vi } from "vitest";

const cdp = vi.hoisted(() => ({
  navigated: [] as Array<{ sessionId: string; url: string }>,
  targets: [
    {
      id: "ext",
      type: "page",
      url: "chrome-extension://abcdef/popup.html",
      title: "popup",
    },
    { id: "web", type: "page", url: "https://site.test/", title: "site" },
  ],
}));

vi.mock("../lib/cdp", () => ({
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
    async navigate(sessionId: string, url: string) {
      cdp.navigated.push({ sessionId, url });
    }
    async evaluate() {
      return {};
    }
    async getPageMeta() {
      return {};
    }
    getConsoleSummary() {
      return {};
    }
    async getPageHTML() {
      return "";
    }
    async getDomSnapshot() {
      return {};
    }
    async getExtensionRootMeta() {
      return {};
    }
    async probeSelectors() {
      return {};
    }
    async getClosedShadowRoots() {
      return {};
    }
    disconnect() {}
  },
}));

vi.mock("../lib/cdp-port", () => ({
  resolveCdpPort: async () => ({ port: 9222 }),
  CDP_PORT_MISSING_HINT: "",
}));

import { handler } from "../tools/inspect";

describe("extension_inspect navigation fallback", () => {
  it("navigates a web page, not an open extension surface, when url matches nothing", async () => {
    cdp.navigated.length = 0;
    const out = JSON.parse(
      await handler({
        projectPath: "/p",
        browser: "chrome",
        url: "https://nomatch.example/",
        include: [],
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.target.id).toBe("web");
    expect(cdp.navigated).toEqual([
      { sessionId: "session-web", url: "https://nomatch.example/" },
    ]);
  }, 10000);

  it("falls back to the extension surface only when nothing else is open", async () => {
    cdp.navigated.length = 0;
    const prev = cdp.targets;
    cdp.targets = [prev[0]];
    try {
      const out = JSON.parse(
        await handler({
          projectPath: "/p",
          browser: "chrome",
          url: "https://nomatch.example/",
          include: [],
        }),
      );
      expect(out.value.target.id).toBe("ext");
    } finally {
      cdp.targets = prev;
    }
  }, 10000);
});
