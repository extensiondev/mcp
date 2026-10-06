import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const actCalls: string[][] = [];
let attachedId = "";
let engineReply: (cli: string[]) => string = (cli) =>
  envelope({ ok: true, command: "extension_open", status: "ok", value: { opened: cli[1] } });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      actCalls.push(cli);
      return engineReply(cli);
    },
  };
});

const bridgeNavigations: string[] = [];
vi.mock("../lib/bridge-tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge-tabs")>();
  return {
    ...actual,
    resolveBridgeBaseUrl: async () => "moz-extension://abc/",
    navigateToUrlViaBridge: async (_p: string, _b: string, url: string) => {
      bridgeNavigations.push(url);
      return envelope({ ok: true, command: "extension_open", status: "navigated", value: { url, created: true } });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

let browserProduct = "Chrome/151.0.7922.71";
let browserUserAgent = "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36";
type Target = { id: string; type: string; url: string; title?: string };
let cdpTargets: Target[] = [];
let afterLanding: ((targets: Target[]) => Target[]) | null = null;
const createdTabs: string[] = [];
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    static async discoverBrowserVersion() {
      return browserProduct;
    }
    static async discoverUserAgent() {
      return browserUserAgent;
    }
    async connect() {}
    async attachToTarget(id: string) {
      attachedId = id;
      return "session-1";
    }
    async enableDomains() {}
    async navigate(_s: string, url: string) {
      cdpTargets = cdpTargets.map((t) => (t.id === attachedId ? { ...t, url } : t));
    }
    async evaluate() {
      return null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const url = String(params?.url ?? "");
        createdTabs.push(url);
        cdpTargets = [...cdpTargets, { id: "created", type: "page", url }];
        if (afterLanding) {
          const swap = afterLanding;
          setTimeout(() => {
            cdpTargets = swap(cdpTargets);
          }, 150);
        }
        return { targetId: "created" };
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const open = await import("../tools/open");

function expectedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }
  return id;
}

const dirs: string[] = [];
function project(browser = "chrome"): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-headless-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest =
    browser === "firefox"
      ? {
          manifest_version: 2,
          name: "F",
          browser_action: { default_popup: "action/index.html" },
          options_ui: { page: "options.html" },
        }
      : {
          manifest_version: 3,
          name: "F",
          action: { default_popup: "action/index.html" },
          options_ui: { page: "options.html" },
        };
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));
  const distPath = path.join(dir, "dist", browser);
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  return { dir, id: expectedId(distPath) };
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["EXTENSION_HEADLESS", "EXTENSION_BROWSER_FLAGS"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ["EXTENSION_HEADLESS", "EXTENSION_BROWSER_FLAGS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  actCalls.length = 0;
  createdTabs.length = 0;
  bridgeNavigations.length = 0;
  cdpTargets = [];
  afterLanding = null;
  browserProduct = "Chrome/151.0.7922.71";
  browserUserAgent = "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36";
  engineReply = (cli) =>
    envelope({ ok: true, command: "extension_open", status: "ok", value: { opened: cli[1] } });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open reads headlessness off the browser, not the environment", () => {
  it("renders a popup as a tab when the browser calls itself HeadlessChrome, without asking the engine", async () => {
    const p = project();
    browserProduct = "HeadlessChrome/151.0.7922.71";
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(result.value.renderedAsTab.surface).toBe("popup");
    expect(createdTabs).toEqual([`chrome-extension://${p.id}/action/index.html`]);
    expect(actCalls).toEqual([]);
    expect(result.warnings.join(" ")).toContain("reports itself headless");
  });

  it("does the same for options", async () => {
    const p = project();
    browserProduct = "HeadlessChrome/151.0.7922.71";

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options" }));

    expect(result.ok).toBe(true);
    expect(result.value.renderedAsTab.surface).toBe("options");
    expect(actCalls).toEqual([]);
  });

  it("reads new headless off the User-Agent when the Browser field still says Chrome", async () => {
    const p = project();
    browserProduct = "Chrome/151.0.7922.71";
    browserUserAgent = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36";
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup" }));

    expect(result.ok).toBe(true);
    expect(result.value.renderedAsTab.surface).toBe("popup");
    expect(actCalls).toEqual([]);
    expect(result.warnings.join(" ")).toContain("reports itself headless");
  });

  it("asks the engine for the real window when the browser is headed", async () => {
    const p = project();
    cdpTargets = [{ id: "pop", type: "page", url: `chrome-extension://${p.id}/action/index.html` }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup" }));

    expect(actCalls).toHaveLength(1);
    expect(actCalls[0].slice(0, 2)).toEqual(["open", "popup"]);
    expect(result.ok).toBe(true);
    expect(result.value.surfaceTarget.targetId).toBe("pop");
  });
});

describe("extension_open falls back to the tab route on any window refusal, however the session was launched", () => {
  it("renders the popup as a tab when Chromium refuses it for lack of a gesture", async () => {
    const p = project();
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];
    engineReply = (cli) =>
      cli[1] === "popup"
        ? envelope({
            ok: false,
            command: "extension_open",
            status: "refused",
            error: {
              code: open.E_USER_GESTURE_REQUIRED,
              name: "UserGestureRequired",
              message: "Chromium opens the popup only in response to a user gesture, so extension open popup can't open it from the command line.",
            },
          })
        : envelope({ ok: true, command: "extension_open", status: "ok", value: {} });

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(result.value.renderedAsTab.surface).toBe("popup");
    expect(createdTabs).toEqual([`chrome-extension://${p.id}/action/index.html`]);
    expect(actCalls).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("only from a real user gesture");
    expect(result.warnings.join(" ")).toMatch(/refused before asking the browser/);
    expect(result.warnings.join(" ")).toMatch(/can't open it from the command line/);
    expect(result.warnings.join(" ")).not.toMatch(/which automation cannot produce/);
    expect(result.hint).toMatch(/no user gesture \(no activeTab grant/);
    expect(result.hint).not.toMatch(/context: 'action'/);
  });

  it("renders the options page as a tab when the engine says opened but no document ever appears", async () => {
    const p = project();
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options" }));

    expect(result.ok).toBe(true);
    expect(result.value.renderedAsTab.surface).toBe("options");
    expect(createdTabs).toEqual([`chrome-extension://${p.id}/options.html`]);
    expect(result.warnings.join(" ")).toContain("no document for it appeared within 3s");
    expect(result.value.engineResult).toBeTruthy();
  }, 15_000);

  it("renders a Gecko popup as a tab with Gecko wording when the browser cannot open it programmatically", async () => {
    const p = project("firefox");
    engineReply = () =>
      envelope({
        ok: false,
        command: "extension_open",
        status: "failed",
        error: { code: "E_NOT_IMPLEMENTED", name: "Unsupported", message: "openPopup: Popup is disabled" },
      });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "firefox", surface: "popup" }),
    );

    expect(result.ok).toBe(true);
    expect(bridgeNavigations).toEqual(["moz-extension://abc/action/index.html"]);
    expect(result.warnings.join(" ")).toContain("The engine refused to open the popup on firefox");
    expect(result.warnings.join(" ")).not.toMatch(/cannot open the popup programmatically/);
    expect(result.warnings.join(" ")).not.toContain("Chromium");
  });

  it("quotes the engine's refusal when a Gecko browser gets the Chromium gesture text, with no stale engine story", async () => {
    const p = project("firefox");
    engineReply = () =>
      envelope({
        ok: false,
        command: "extension_open",
        status: "refused",
        error: {
          code: open.E_USER_GESTURE_REQUIRED,
          name: "UserGestureRequired",
          message: "Chromium opens the popup only in response to a user gesture, so extension open popup can't open it from the command line.",
        },
      });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "zen", surface: "popup" }),
    );

    expect(result.ok).toBe(true);
    expect(bridgeNavigations).toEqual(["moz-extension://abc/action/index.html"]);
    expect(result.warnings.join(" ")).toContain("The engine refused to open the popup on zen before asking the browser");
  });
});

describe("extension_open refuses a page the browser swapped for its own error page", () => {
  it("reports navigate-blocked with the browser's title instead of navigated", async () => {
    const p = project();
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];
    afterLanding = (targets) =>
      targets.map((t) =>
        t.id === "created"
          ? { ...t, url: "chrome-error://chromewebdata/", title: "This page has been blocked by Microsoft Edge" }
          : t,
      );

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("navigate-blocked");
    expect(result.error.name).toBe("PageBlocked");
    expect(result.error.message).toContain("blocked by Microsoft Edge");
    expect(result.value.target.url).toBe("chrome-error://chromewebdata/");
  }, 15_000);

  it("still answers navigated when the page stays", async () => {
    const p = project();
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "popup", asTab: true }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
  });
});
