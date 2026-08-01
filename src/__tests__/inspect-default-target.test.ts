import { describe, expect, it, vi } from "vitest";

const COMPANION = "kgdaecdpfkikjncaalnmmnjjfpofkcbl";

const cdp = vi.hoisted(() => ({
  targets: [] as Array<{ id: string; type: string; url: string; title: string }>,
  evaluations: [] as string[],
  evalResult: undefined as unknown,
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
    async navigate() {}
    async evaluate(_sessionId: string, expr: string) {
      cdp.evaluations.push(expr);
      return expr === "location.href" ? cdp.evalResult : {};
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

describe("extension_inspect default target selection", () => {
  it("prefers the guest's surface over the toolchain's newtab welcome page", async () => {
    cdp.targets = [
      { id: "welcome", type: "page", url: "chrome://newtab/", title: "Welcome" },
      {
        id: "guest",
        type: "page",
        url: "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/popup.html",
        title: "popup",
      },
    ];
    const out = JSON.parse(
      await handler({ projectPath: "/p", browser: "chrome", include: [] }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.target.id).toBe("guest");
    expect(out.warnings).toEqual([]);
  });

  it("ranks the engine companion's own pages last", async () => {
    cdp.targets = [
      {
        id: "companion",
        type: "page",
        url: `chrome-extension://${COMPANION}/welcome.html`,
        title: "Extension.js",
      },
      { id: "web", type: "page", url: "https://site.test/", title: "site" },
    ];
    const out = JSON.parse(
      await handler({ projectPath: "/p", browser: "chrome", include: [] }),
    );
    expect(out.value.target.id).toBe("web");
  });

  it("names the toolchain when only its welcome override is open", async () => {
    cdp.targets = [
      { id: "welcome", type: "page", url: "chrome://newtab/", title: "Welcome" },
    ];
    cdp.evaluations.length = 0;
    cdp.evalResult = `chrome-extension://${COMPANION}/pages/welcome.html`;
    const out = JSON.parse(
      await handler({ projectPath: "/p", browser: "chrome", include: [] }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.target.id).toBe("welcome");
    expect(out.value.target.documentUrl).toContain(COMPANION);
    expect(out.warnings.join(" ")).toMatch(/toolchain/);
    expect(out.warnings.join(" ")).toMatch(/not by this project/);
  });

  it("still warns, without accusing the guest, when the override's document is not the companion", async () => {
    cdp.targets = [
      { id: "welcome", type: "page", url: "chrome://newtab/", title: "tab" },
    ];
    cdp.evalResult =
      "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/newtab.html";
    const out = JSON.parse(
      await handler({ projectPath: "/p", browser: "chrome", include: [] }),
    );
    expect(out.value.target.id).toBe("welcome");
    expect(out.warnings.join(" ")).toMatch(/pass url or open a surface/i);
    expect(out.warnings.join(" ")).not.toMatch(/not by this project/);
  });

  it("keeps explicit url selection untouched", async () => {
    cdp.targets = [
      { id: "welcome", type: "page", url: "chrome://newtab/", title: "Welcome" },
      { id: "web", type: "page", url: "https://site.test/", title: "site" },
    ];
    const out = JSON.parse(
      await handler({
        projectPath: "/p",
        browser: "chrome",
        url: "https://site.test/",
        include: [],
      }),
    );
    expect(out.value.target.id).toBe("web");
    expect(out.warnings).toEqual([]);
  });
});
