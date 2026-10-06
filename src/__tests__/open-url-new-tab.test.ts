import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";
import { actFrame, tabRows } from "./fixtures/engine-answers";

const actCalls: string[][] = [];
let lastTabId = 9;
let lastNavigateUrl = "";
let attachedId = "";
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      actCalls.push(cli);
      if (cli.includes("--list-tabs")) {
        return JSON.stringify(
          actFrame("inspect", tabRows([{ id: lastTabId, url: lastNavigateUrl, title: "Landed" }])),
        );
      }
      lastTabId = cli.includes("--tab") ? Number(cli[cli.indexOf("--tab") + 1]) : 9;
      lastNavigateUrl = String(cli[1] ?? "");
      return envelope({
        ok: true,
        command: "extension_open",
        status: "ok",
        value: { tabId: lastTabId, created: cli.includes("--new-tab") },
      });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

const navigations: string[] = [];
const createdTabs: Array<{ url: string; background: boolean }> = [];
let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> = [];
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
    async navigate(_s: string, url: string) {
      navigations.push(url);
      cdpTargets = cdpTargets.map((t) => (t.id === attachedId ? { ...t, url } : t));
    }
    async evaluate() {
      return null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const url = String(params?.url ?? "");
        createdTabs.push({ url, background: params?.background === true });
        cdpTargets = [...cdpTargets, { id: "created", type: "page", url }];
        return { targetId: "created" };
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

vi.mock("../lib/bridge-tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge-tabs")>();
  return { ...actual, resolveBridgeBaseUrl: async () => "moz-extension://abc/" };
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-url-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", action: { default_popup: "popup.html" } }),
  );
  const distPath = path.join(dir, "dist", browser);
  const readyDir = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  return { dir, id: expectedId(distPath) };
}

afterEach(() => {
  actCalls.length = 0;
  navigations.length = 0;
  createdTabs.length = 0;
  cdpTargets = [];
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open with a url never takes over a page the agent was watching", () => {
  it("opens a new tab when the only open tab is one of the extension's own pages", async () => {
    const p = project();
    cdpTargets = [
      { id: "panel", type: "page", url: `chrome-extension://${p.id}/pages/devpanel.html` },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, url: "https://example.com/" }),
    );

    expect(result.ok).toBe(true);
    expect(createdTabs).toEqual([{ url: "https://example.com/", background: true }]);
    expect(navigations).toEqual([]);
    expect(cdpTargets.find((t) => t.id === "panel")?.url).toContain("devpanel.html");
  });

  it("still reuses a blank tab", async () => {
    const p = project();
    cdpTargets = [{ id: "reused", type: "page", url: "about:blank" }];

    await open.handler({ projectPath: p.dir, url: "https://example.com/" });

    expect(navigations).toEqual(["https://example.com/"]);
    expect(createdTabs).toEqual([]);
  });

  it("resolves a scheme-less path against the extension's own origin", async () => {
    const p = project();
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, url: "pages/options.html" }),
    );

    expect(result.ok).toBe(true);
    expect(createdTabs[0].url).toBe(`chrome-extension://${p.id}/pages/options.html`);
  });

  it("navigates the named tab in place through the engine's navigate verb", async () => {
    const p = project();
    cdpTargets = [{ id: "watched", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, url: "https://example.com/next", tab: 7 }),
    );

    expect(result.ok).toBe(true);
    expect(actCalls.filter((c) => c[0] === "navigate")).toHaveLength(1);
    expect(actCalls[0].slice(0, 2)).toEqual(["navigate", "https://example.com/next"]);
    expect(actCalls[0]).toContain("--tab");
    expect(actCalls[0][actCalls[0].indexOf("--tab") + 1]).toBe("7");
    expect(actCalls[0]).not.toContain("--new-tab");
    expect(createdTabs).toEqual([]);
  });

  it("asks the Gecko navigate verb for a new tab, and resolves a relative path against the moz-extension base", async () => {
    const p = project("firefox");

    const web = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "firefox", url: "https://example.com/" }),
    );
    const relative = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "firefox", url: "pages/options.html" }),
    );

    const navigates = actCalls.filter((c) => c[0] === "navigate");
    expect(web.ok).toBe(true);
    expect(navigates[0].slice(0, 2)).toEqual(["navigate", "https://example.com/"]);
    expect(navigates[0]).toContain("--new-tab");
    expect(relative.ok).toBe(true);
    expect(navigates[1][1]).toBe("moz-extension://abc/pages/options.html");
    expect(web.value.created).toBe(true);
  });
});
