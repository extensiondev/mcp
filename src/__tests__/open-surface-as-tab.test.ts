import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const navigations: string[] = [];
let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> =
  [];
let cdpPort: { port: number } | null = { port: 9222 };
// When false, a navigation does NOT produce a live target, the shape of a
// blocked or 404'd navigation, which must be reported as a failure.
let navigationLands = true;

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
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
    async attachToTarget() {
      return "session-1";
    }
    async navigate(_session: string, url: string) {
      navigations.push(url);
      // Chrome creates/updates a page target on a successful load. The old
      // pre-navigation session is NOT a reliable signal (cross-process swap),
      // which is exactly what the live run exposed.
      if (navigationLands) {
        cdpTargets = [
          ...cdpTargets.filter((t) => t.type !== "page"),
          { id: "navigated", type: "page", url, title: "Landed" },
        ];
      }
    }
    async getPageMeta() {
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const open = await import("../tools/open");

// Chrome's unpacked-extension id: SHA-256 of the absolute dist path, first 16
// bytes, nibbles mapped onto a-p. Duplicated here on purpose so the test pins
// the algorithm independently of the implementation.
function expectedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }
  return id;
}

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
      JSON.stringify({ status: "ready", distPath }),
    );
  }
  return { dir, distPath, id: expectedId(distPath) };
}

afterEach(() => {
  navigations.length = 0;
  cdpPort = { port: 9222 };
  cdpTargets = [];
  navigationLands = true;
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
    expect(result.renderedAsTab.extensionId).toBe(p.id);
    expect(result.hint).toContain("NOT hosted in a popup window");
  });

  // THE BUG THE LIVE RUN CAUGHT. A dev session also loads Extension.js's own
  // manager extension; taking the first chrome-extension:// target navigated
  // the popup path against the WRONG origin and 404'd, while still reporting
  // ok:true. The id must come from the dist path, not from target order.
  it("picks the project's extension, not another loaded extension", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });
    cdpTargets = [
      // The manager extension appears FIRST in the target list.
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

  // THE OTHER LIVE BUG: a navigation that never lands used to return ok:true.
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
    // Exceeds the 5s default: the handler spends its full 6s poll budget
    // waiting for a target that never appears.
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
    expect(navigations).toEqual([]);
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
