import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { readyContract } from "./fixtures/engine-answers";
import { unpackedExtensionId } from "../lib/extension-identity";

import type * as CdpPortModule from "../lib/cdp-port";

const navigations: string[] = [];
let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> =
  [];
let cdpPort: { port: number; source: "contract" } | null = { port: 9222, source: "contract" };
let navigationLands = true;
let attachedId = "";
let popupMeasure: { w: number; h: number } | null = null;
let windowResizeHonored = true;
let windowBounds: { width?: number; height?: number } = {};
const evaluatedExpressions: string[] = [];
const createdTabs: Array<{ url: string; background: boolean }> = [];
const workerEvaluations: Array<{ expression: string; sessionId: string }> = [];
let workerAnswer: Record<string, unknown> = { outcome: "dispatched" };

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => cdpPort };
});

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(id: string) {
      attachedId = id;

      return "session-1";
    }
    async enableDomains() {}
    async navigate(_session: string, url: string) {
      navigations.push(url);

      if (navigationLands) {
        cdpTargets = cdpTargets.map((t) =>
          t.id === attachedId ? { ...t, url, title: "Landed" } : t,
        );
      }
    }
    async getPageMeta() {
      return {};
    }
    async evaluate(_session: string, expression: string) {
      evaluatedExpressions.push(expression);

      return popupMeasure ? { w: popupMeasure.w, h: popupMeasure.h } : null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const url = String(params?.url ?? "");
        navigations.push(url);
        createdTabs.push({ url, background: params?.background === true });

        if (navigationLands) {
          cdpTargets = [
            ...cdpTargets,
            { id: "created", type: "page", url, title: "Landed" },
          ];
        }

        return { targetId: "created" };
      }

      if (method === "Browser.getWindowForTarget") return { windowId: 7 };

      if (method === "Runtime.evaluate" && attachedId.startsWith("sw")) {
        workerEvaluations.push({ expression: String(params?.expression), sessionId: "session-1" });

        return { result: { type: "object", value: workerAnswer } };
      }

      if (method === "Browser.setWindowBounds") {
        if (windowResizeHonored) {
          windowBounds = { ...(params?.bounds as Record<string, number>) };
        }

        return {};
      }

      if (method === "Browser.getWindowBounds") return { bounds: windowBounds };

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const open = await import("../tools/open");

const tmpDirs: string[] = [];

function project(
  manifest: Record<string, unknown>,
  opts: { browser?: string; withReady?: boolean } = {},
): { dir: string; distPath: string; id: string } {
  const browser = opts.browser ?? "chrome";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-tab-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify(manifest),
  );

  const distPath = path.join(dir, "dist", browser);

  if (opts.withReady !== false) {
    const readyDir = path.join(dir, "dist", "extension-js", browser);
    fs.mkdirSync(readyDir, { recursive: true });
    fs.writeFileSync(
      path.join(readyDir, "ready.json"),
      JSON.stringify(readyContract("dev", "chrome", { distPath, extensionId: undefined })),
    );
  }

  return { dir, distPath, id: unpackedExtensionId(distPath) };
}

afterEach(() => {
  navigations.length = 0;
  workerEvaluations.length = 0;
  workerAnswer = { outcome: "dispatched" };
  cdpPort = { port: 9222, source: "contract" };
  cdpTargets = [];
  navigationLands = true;
  popupMeasure = null;
  windowResizeHonored = true;
  windowBounds = {};
  evaluatedExpressions.length = 0;
  createdTabs.length = 0;

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("open surface asTab", () => {
  it("renders the popup document in a tab", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(true);
    expect(navigations).toEqual([`chrome-extension://${p.id}/popup.html`]);
    expect(result.value.renderedAsTab.extensionId).toBe(p.id);
    expect(result.hint).toContain("NOT hosted in a popup window");
  });

  it("picks the project's extension, not another loaded extension", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [
      {
        id: "mgr",
        type: "service_worker",
        url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background/service_worker.js",
      },
      {
        id: "mine",
        type: "service_worker",
        url: `chrome-extension://${p.id}/background/service_worker.js`,
      },
      { id: "t1", type: "page", url: "https://example.com" },
    ];

    await open.handler({ projectPath: p.dir, surface: "popup", asTab: true });

    expect(navigations).toEqual([`chrome-extension://${p.id}/popup.html`]);
    expect(navigations[0]).not.toContain("aaaaaaaa");
  });

  it("reports failure when the navigation does not produce a live target", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];
    navigationLands = false;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NavigateFailed");
  }, 15_000);

  it("resolves the options document from options_ui.page", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      options_ui: { page: "options/index.html" },
    });
    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    await open.handler({ projectPath: p.dir, surface: "options", asTab: true });

    expect(navigations).toEqual([
      `chrome-extension://${p.id}/options/index.html`,
    ]);
  });

  it("reports honestly when the manifest declares no such surface", async () => {
    const p = project({ manifest_version: 3, name: "F" });
    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSurfaceDocument");
    expect(result.error.message).toContain("declares no popup");
    expect(result.error.message).toContain("action.default_popup");
    expect(result.error.message).toContain("not a failure");
    expect(result.hint).toContain('surface: "action"');
    expect(navigations).toEqual([]);
  });

  it("names the surfaces the extension DOES declare when the popup is absent", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      options_ui: { page: "options.html" },
      side_panel: { default_path: "panel.html" },
    });
    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.value.declaredSurfaces).toEqual(["options", "sidebar"]);
    expect(result.hint).toContain("options, sidebar");
  });

  it("falls back to the single live extension when there is no ready contract", async () => {
    const p = project(
      { manifest_version: 3, name: "F", action: { default_popup: "popup.html" } },
      { withReady: false },
    );
    cdpTargets = [
      {
        id: "only",
        type: "service_worker",
        url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/sw.js",
      },
      { id: "t1", type: "page", url: "https://example.com" },
    ];

    await open.handler({ projectPath: p.dir, surface: "popup", asTab: true });

    expect(navigations).toEqual([
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/popup.html",
    ]);
  });

  it("refuses to guess when several extensions are live and there is no contract", async () => {
    const p = project(
      { manifest_version: 3, name: "F", action: { default_popup: "popup.html" } },
      { withReady: false },
    );
    cdpTargets = [
      {
        id: "a",
        type: "service_worker",
        url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sw.js",
      },
      {
        id: "b",
        type: "service_worker",
        url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/sw.js",
      },
      { id: "t1", type: "page", url: "https://example.com" },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoExtensionId");
    expect(navigations).toEqual([]);
  });

  it("prefers the built manifest over src", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "src-popup.html" },
    });
    fs.mkdirSync(p.distPath, { recursive: true });
    fs.writeFileSync(
      path.join(p.distPath, "manifest.json"),
      JSON.stringify({ action: { default_popup: "action/index.html" } }),
    );

    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    await open.handler({
      projectPath: p.dir,
      browser: "chrome",
      surface: "popup",
      asTab: true,
    });

    expect(navigations).toEqual([
      `chrome-extension://${p.id}/action/index.html`,
    ]);
  });
});

describe("open trusts the live browser over the computed id hash", () => {
  const LIVE_ID = "c".repeat(32);
  const COMPANION_ID = "kgdaecdpfkikjncaalnmmnjjfpofkcbl";

  it("navigates to the CDP-observed id when the computed hash is not in the target list", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [
      {
        id: "live",
        type: "service_worker",
        url: `chrome-extension://${LIVE_ID}/background/service_worker.js`,
      },
      { id: "t1", type: "page", url: "https://example.com" },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(true);
    expect(navigations).toEqual([`chrome-extension://${LIVE_ID}/popup.html`]);
    expect(result.value.renderedAsTab.extensionId).toBe(LIVE_ID);
  });

  it("does not mistake the engine companion for the guest when picking the live id", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [
      {
        id: "companion",
        type: "service_worker",
        url: `chrome-extension://${COMPANION_ID}/sw.js`,
      },
      {
        id: "live",
        type: "service_worker",
        url: `chrome-extension://${LIVE_ID}/sw.js`,
      },
      { id: "t1", type: "page", url: "https://example.com" },
    ];

    await open.handler({ projectPath: p.dir, surface: "popup", asTab: true });

    expect(navigations).toEqual([`chrome-extension://${LIVE_ID}/popup.html`]);
  });

  it("recognizes its own extension through a symlinked dist path", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    const realDist = path.join(p.dir, "real-dist");
    fs.mkdirSync(realDist, { recursive: true });
    const linkedDist = path.join(p.dir, "linked-dist");
    fs.symlinkSync(realDist, linkedDist);
    const readyDir = path.join(p.dir, "dist", "extension-js", "chrome");
    fs.writeFileSync(
      path.join(readyDir, "ready.json"),
      JSON.stringify(readyContract("dev", "chrome", { distPath: linkedDist, extensionId: undefined })),
    );

    const realId = unpackedExtensionId(fs.realpathSync(linkedDist));
    cdpTargets = [
      {
        id: "live",
        type: "service_worker",
        url: `chrome-extension://${realId}/sw.js`,
      },
      { id: "t1", type: "page", url: "https://example.com" },
    ];

    await open.handler({ projectPath: p.dir, surface: "popup", asTab: true });

    expect(navigations).toEqual([`chrome-extension://${realId}/popup.html`]);
  });
});

describe("open never destroys the page you were watching", () => {
  it("opens a new background tab instead of taking over a real page", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [
      { id: "watched", type: "page", url: "https://example.com/watched" },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(result.value.openedNewTab).toBe(true);
    expect(createdTabs).toEqual([
      { url: `chrome-extension://${p.id}/popup.html`, background: true },
    ]);

    expect(
      cdpTargets.find((t) => t.id === "watched")?.url,
    ).toBe("https://example.com/watched");
  });

  it("reuses a blank tab rather than piling up new ones", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [{ id: "blank", type: "page", url: "about:blank" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.openedNewTab).toBeUndefined();
    expect(createdTabs).toEqual([]);
    expect(navigations).toEqual([`chrome-extension://${p.id}/popup.html`]);
  });

  it("436: leaves an extension tab this tool did not render alone and opens its own", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
      options_ui: { page: "options.html" },
    });
    cdpTargets = [
      { id: "watched", type: "page", url: "https://example.com" },
      { id: "surface", type: "page", url: `chrome-extension://${p.id}/popup.html` },
    ];

    await open.handler({ projectPath: p.dir, surface: "options", asTab: true });

    expect(createdTabs.map((t) => t.url)).toEqual([`chrome-extension://${p.id}/options.html`]);
    expect(cdpTargets.find((t) => t.id === "surface")?.url).toBe(`chrome-extension://${p.id}/popup.html`);
  });

  it("treats a client-side redirect as a landing, not a NavigateFailed", async () => {
    const p = project({ manifest_version: 3, name: "F" });
    cdpTargets = [];
    navigationLands = false;
    const asked = "https://example.com/start";

    const pending = open.handler({ projectPath: p.dir, url: asked });
    await new Promise((r) => setTimeout(r, 300));
    cdpTargets = [
      {
        id: "created",
        type: "page",
        url: "https://example.com/landed",
        title: "Landed",
      },
    ];

    const result = JSON.parse(await pending);

    expect(result.ok).toBe(true);
    expect(result.value.redirected).toEqual({
      from: asked,
      to: "https://example.com/landed",
    });

    expect(result.value.target.targetId).toBe("created");
  }, 15_000);

  it("does not blame the extension bundle for a failed http navigation", async () => {
    const p = project({ manifest_version: 3, name: "F" });
    cdpTargets = [];
    navigationLands = false;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, url: "https://example.com/nope" }),
    );

    expect(result.ok).toBe(false);
    expect(result.hint).not.toMatch(/built dist|BUILT manifest|entrypoints/);
    expect(result.hint).toMatch(/implicated only if it blocks the request itself/);
    expect(result.hint).not.toMatch(/Nothing about your extension bundle is implicated in a failed/);
  }, 15_000);
});

describe("popup-as-tab window sizing", () => {
  function popupProject() {
    const p = project({});
    fs.mkdirSync(p.distPath, { recursive: true });
    fs.writeFileSync(
      path.join(p.distPath, "manifest.json"),
      JSON.stringify({ action: { default_popup: "popup.html" } }),
    );

    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    return p;
  }

  it("resizes the window to the measured content size", async () => {
    const p = popupProject();
    popupMeasure = { w: 360, h: 240 };

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.renderedAsTab.popupBounds).toEqual({
      width: 360,
      height: 240,
      clamped: false,
    });

    expect(windowBounds).toEqual({ width: 360, height: 240 });
    expect(result.hint).toContain("resized to the popup's content size (360x240");
  });

  it("clamps oversized content to Chrome's popup bounds and says so", async () => {
    const p = popupProject();
    popupMeasure = { w: 1200, h: 2000 };

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.value.renderedAsTab.popupBounds).toEqual({
      width: 800,
      height: 600,
      clamped: true,
    });

    expect(result.hint).toContain("clamped");
  });

  it("never overrides the BODY width when measuring content size", async () => {
    const p = popupProject();
    popupMeasure = { w: 320, h: 180 };

    await open.handler({ projectPath: p.dir, surface: "popup", asTab: true });

    const measure = evaluatedExpressions.find((e) => e.includes("fit-content"));
    expect(measure).toBeDefined();
    expect(measure).not.toMatch(/b(ody)?\.style\.width\s*=/);
    expect(measure).toMatch(/de\.style\.width\s*=\s*"fit-content"/);
  });

  it("does not claim popup fidelity when the browser ignored the resize", async () => {
    const p = popupProject();
    popupMeasure = { w: 360, h: 240 };
    windowResizeHonored = false;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.renderedAsTab.popupBounds).toBeUndefined();
    expect(result.hint).toContain("no popup sizing");
  });

  it("clampPopupBounds enforces the 25x25 floor", () => {
    expect(open.clampPopupBounds(10, 10)).toEqual({
      width: 25,
      height: 25,
      clamped: true,
    });
  });
});

describe("open never calls a tab that stayed put navigated", () => {
  it("reports a reused new-tab page that never left chrome://newtab as not navigated", async () => {
    const p = project({ manifest_version: 3, name: "F" });
    cdpTargets = [{ id: "ntp", type: "page", url: "chrome://newtab/" }];
    navigationLands = false;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, url: "https://example.com/file.zip" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("navigate-failed");
    expect(result.value?.redirected).toBeUndefined();
  }, 15_000);

  it("does not let a tab already at a sibling path answer for the one navigated", async () => {
    const p = project({ manifest_version: 3, name: "F" });
    cdpTargets = [
      { id: "other", type: "page", url: "https://example.com/other" },
      { id: "blank", type: "page", url: "about:blank" },
    ];

    navigationLands = false;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, url: "https://example.com" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("navigate-failed");
  }, 15_000);
});

describe("436: a surface rendered as a tab never takes over a tab opened by url", () => {
  it("opens its own tab beside an extension page the agent opened a moment earlier", async () => {
    const p = project({ manifest_version: 3, name: "Hands-free", options_ui: { page: "options.html" } });
    const welcome = `chrome-extension://${p.id}/pages/welcome.html?step=practice`;
    cdpTargets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/background.js` },
      { id: "welcome", type: "page", url: welcome, title: "Welcome" },
    ];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options", asTab: true }));

    expect(result.ok).toBe(true);
    expect(result.value.openedNewTab).toBe(true);
    expect(result.value.reused).toBeUndefined();
    expect(result.value.target.targetId).toBe("created");
    expect(createdTabs.map((t) => t.url)).toEqual([`chrome-extension://${p.id}/options.html`]);
    expect(cdpTargets.find((t) => t.id === "welcome")?.url).toBe(welcome);
  });

  it("still replaces a tab this tool itself rendered as a surface, and says what it replaced", async () => {
    const p = project({
      manifest_version: 3,
      name: "Hands-free",
      action: { default_popup: "popup.html" },
      options_ui: { page: "options.html" },
    });
    cdpTargets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/background.js` }];

    const popup = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }));
    const options = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options", asTab: true }));

    expect(popup.value.target.targetId).toBe("created");
    expect(options.value.target.targetId).toBe("created");
    expect(options.value.reused).toBe(true);
    expect(options.value.replaced).toBe(`chrome-extension://${p.id}/popup.html`);
    expect(createdTabs).toHaveLength(1);
  });
});

describe("extension_open surface: action with menuItemId replays contextMenus.onClicked in the service worker", () => {
  const MENU_MV3 = { manifest_version: 3, name: "F", action: {}, permissions: ["contextMenus"] };

  it("dispatches the click for the named item on the active tab over the debug port and says it carried no gesture", async () => {
    const p = project(MENU_MV3);
    cdpTargets = [
      { id: "t1", type: "page", url: "https://example.com" },
      { id: "sw1", type: "service_worker", url: `chrome-extension://${p.id}/background.js` },
    ];

    workerAnswer = { outcome: "dispatched", tab: { id: 7, url: "https://example.com/", title: "Example" }, info: { menuItemId: "cat-idle", editable: false, pageUrl: "https://example.com/" } };

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "action", menuItemId: "cat-idle" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("replayed");
    expect(result.value).toMatchObject({ surface: "action", replayed: "contextMenus.onClicked", menuItemId: "cat-idle", gesture: false, trusted: false, route: "debug-port", tab: { id: 7 } });
    expect(workerEvaluations).toHaveLength(1);
    expect(workerEvaluations[0].expression).toContain('"cat-idle"');
    expect(workerEvaluations[0].expression).toContain("chrome.tabs.query");
    expect(workerEvaluations[0].expression).toContain("event.dispatch(info, tab");
    expect(navigations).toEqual([]);
    expect(result.hint).toContain("no user gesture");
    expect(result.hint).toContain("not checked against the registered items");
  });

  it("reads the tab by id when tab is given and refuses a tab the browser does not know", async () => {
    const p = project(MENU_MV3);
    cdpTargets = [{ id: "sw1", type: "service_worker", url: `chrome-extension://${p.id}/background.js` }];
    workerAnswer = { outcome: "no-tab", message: "No tab with id: 99." };

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "action", menuItemId: "cat-idle", tab: 99 }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("tab-not-found");
    expect(result.error.code).toBe("E_TAB_NOT_FOUND");
    expect(workerEvaluations[0].expression).toContain("chrome.tabs.get(99)");
  });

  it("answers no-listener, no-context-menus and no-dispatch as fixed statuses", async () => {
    const p = project(MENU_MV3);
    cdpTargets = [{ id: "sw1", type: "service_worker", url: `chrome-extension://${p.id}/background.js` }];

    for (const [outcome, status, code] of [
      ["no-listener", "no-listener", "E_NO_LISTENER"],
      ["no-api", "no-context-menus", "E_NO_CONTEXT_MENUS"],
      ["no-dispatch", "unsupported-browser", "E_UNSUPPORTED_BROWSER"],
    ]) {
      workerAnswer = { outcome };

      const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "action", menuItemId: "cat-idle" }));

      expect(result.ok, outcome).toBe(false);
      expect(result.status, outcome).toBe(status);
      expect(result.error.code, outcome).toBe(code);
    }
  });

  it("names the missing background when no service worker of the extension runs, refuses on Firefox before any port, and refuses a menuItemId without surface: action", async () => {
    const p = project(MENU_MV3);
    cdpTargets = [{ id: "t1", type: "page", url: "https://example.com" }];

    const none = JSON.parse(await open.handler({ projectPath: p.dir, surface: "action", menuItemId: "cat-idle" }));

    expect(none.ok).toBe(false);
    expect(none.status).toBe("no-background");
    expect(none.error.code).toBe("E_NO_BACKGROUND");

    const gecko = project(MENU_MV3, { browser: "firefox" });
    const refused = JSON.parse(await open.handler({ projectPath: gecko.dir, surface: "action", menuItemId: "cat-idle", browser: "firefox" }));

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe("unsupported-browser");
    expect(refused.error.message).toContain("control channel");

    const misplaced = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup", menuItemId: "cat-idle" }));

    expect(misplaced).toMatchObject({ ok: false, status: "bad-request" });
    expect(misplaced.error.message).toContain("surface: \"action\"");
    expect(workerEvaluations).toEqual([]);
  });

  it("lists menuItemId on the schema beside the action surface", () => {
    const props = open.schema.inputSchema.properties as Record<string, { description: string }>;

    expect(props.menuItemId.description).toContain("contextMenus.onClicked");
    expect(props.tab.description).toContain("menuItemId");
  });
});
