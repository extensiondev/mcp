import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const actCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      actCalls.push(cli);
      return envelope({ ok: true, command: "extension_open", status: "ok", value: {} });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222 }) };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
let openDevToolsSupported = true;
let panelRegisters = true;
let extensionId = "";
const commands: string[] = [];
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    static async discoverBrowserVersion() {
      return "Chrome/151.0.7922.71";
    }
    async connect() {}
    async attachToTarget(id: string) {
      return `session-${id}`;
    }
    async sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string) {
      commands.push(method);
      if (method === "Target.openDevTools") {
        if (!openDevToolsSupported) throw new Error("'Target.openDevTools' wasn't found");
        cdpTargets = [
          ...cdpTargets,
          { id: "dt", type: "page", url: "devtools://devtools/bundled/devtools_app.html?targetType=tab", title: "DevTools" },
          { id: "dtpage", type: "iframe", url: `chrome-extension://${extensionId}/devtools/index.html`, title: "" },
        ];
        return { targetId: "dt" };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("tabIds()")) {
          expect(sessionId).toBe("session-dt");
          return {
            result: {
              value: panelRegisters
                ? ["elements", "console", `chrome-extension://${extensionId}Live`, `chrome-extension://${extensionId}Second`]
                : ["elements", "console"],
            },
          };
        }
        if (expression.includes("showPanel(")) {
          const shownId = /showPanel\("([^"]+)"\)/.exec(expression)?.[1] ?? "";
          const doc = shownId.endsWith("Second") ? "devtools/second.html" : "devtools/panel.html";
          cdpTargets = [
            ...cdpTargets,
            { id: "panel", type: "iframe", url: `chrome-extension://${extensionId}/${doc}`, title: "" },
          ];
          return { result: { value: "shown" } };
        }
        return { result: { value: 1 } };
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const open = await import("../tools/open");
const cdpExtensionPage = await import("../lib/cdp-extension-page");
const evalTool = await import("../tools/eval");

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
function project(options: { devtools?: boolean; browser?: string } = {}): { dir: string; id: string } {
  const browser = options.browser ?? "chrome";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-devtools-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: "F",
    action: { default_popup: "action/index.html" },
  };
  if (options.devtools !== false) manifest.devtools_page = "devtools/index.html";
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));
  const distPath = path.join(dir, "dist", browser);
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  extensionId = expectedId(distPath);
  return { dir, id: extensionId };
}

afterEach(() => {
  actCalls.length = 0;
  commands.length = 0;
  cdpTargets = [];
  openDevToolsSupported = true;
  panelRegisters = true;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open surface devtools opens the real DevTools and shows the extension's panel", () => {
  it("opens DevTools on the web page over Target.openDevTools and hands back the panel document", async () => {
    const p = project();
    cdpTargets = [
      { id: "popup", type: "page", url: `chrome-extension://${p.id}/action/index.html`, title: "P" },
      { id: "web", type: "page", url: "https://example.com/", title: "Example" },
    ];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "devtools" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("opened");
    expect(result.value.inspected.targetId).toBe("web");
    expect(result.value.panel.title).toBe("Live");
    expect(result.value.panel.url).toBe(`chrome-extension://${p.id}/devtools/panel.html`);
    expect(result.value.panel.targetId).toBe("panel");
    expect(result.hint).toContain(`url: "chrome-extension://${p.id}/devtools/panel.html"`);
    expect(commands).toContain("Target.openDevTools");
    expect(actCalls).toEqual([]);
  });

  it("picks the panel by title and the inspected tab by url", async () => {
    const p = project();
    cdpTargets = [
      { id: "a", type: "page", url: "https://example.com/", title: "Example" },
      { id: "b", type: "page", url: "https://news.example.org/", title: "News" },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "devtools", panel: "Second", url: "news.example" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.inspected.targetId).toBe("b");
    expect(result.value.panel.title).toBe("Second");
    expect(result.value.panel.url).toBe(`chrome-extension://${p.id}/devtools/second.html`);
  });

  it("answers surface-did-not-open with the registered titles when the asked panel never registers", async () => {
    const p = project();
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "devtools", panel: "Nope", timeout: 700 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("surface-did-not-open");
    expect(result.error.code).toBe("E_SURFACE_DID_NOT_OPEN");
    expect(result.error.message).toContain("Live, Second");
    expect(result.hint).toContain('No panel is titled "Nope"');
    expect(result.value.devtoolsTargetId).toBe("dt");
  }, 15_000);

  it("says the devtools page registered nothing when no panel of the extension appears", async () => {
    const p = project();
    panelRegisters = false;
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "devtools", timeout: 700 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("surface-did-not-open");
    expect(result.error.message).toContain("devtools/index.html loaded in it");
    expect(result.hint).toContain("extension_logs");
  }, 15_000);

  it("refuses on Gecko without touching the protocol, naming what to do instead", async () => {
    const p = project({ browser: "firefox" });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "devtools", browser: "firefox" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unsupported");
    expect(result.error.code).toBe("E_UNSUPPORTED_BROWSER");
    expect(result.error.message).toContain("Target.openDevTools is Chromium's");
    expect(result.hint).toContain("F12");
    expect(commands).toEqual([]);
  });

  it("names the missing devtools_page when the manifest declares none", async () => {
    const p = project({ devtools: false });
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "devtools" }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(result.error.message).toContain("devtools_page");
    expect(commands).toEqual([]);
  });

  it("reports a browser whose protocol lacks Target.openDevTools as a CDP failure, not a missing surface", async () => {
    const p = project();
    openDevToolsSupported = false;
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "devtools" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cdp-failed");
    expect(result.error.code).toBe("E_CDP");
    expect(result.error.message).toContain("Target.openDevTools");
  });
});

describe("a panel document is reachable as an extension page even though it is an iframe target", () => {
  it("matches iframe targets for an extension url and routes context devtools over CDP on MV3", async () => {
    const p = project();
    cdpTargets = [
      { id: "web", type: "page", url: "https://example.com/", title: "Example" },
      { id: "panel", type: "iframe", url: `chrome-extension://${p.id}/devtools/panel.html`, title: "" },
      { id: "dt", type: "page", url: "devtools://devtools/bundled/devtools_app.html", title: "DevTools" },
    ];

    const matches = await cdpExtensionPage.findExtensionPageTargets(
      9222,
      `chrome-extension://${p.id}/devtools/panel.html`,
    );

    expect(matches.map((t) => t.targetId)).toEqual(["panel"]);
    expect(evalTool.wantsExtensionPageOverCdp(p.dir, "chrome", "devtools", undefined)).toBe(true);
    expect(open.surfaceDocument(p.dir, "chrome", "devtools")).toBe("devtools/index.html");
  });
});
