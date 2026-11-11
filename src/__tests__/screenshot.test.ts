import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { unpackedExtensionId } from "../lib/extension-identity";
import { encodeRdpPacket, RdpPacketDecoder } from "../lib/rdp";
import { browserArtifactsDir, readyContractPath } from "../lib/session-paths";
import { actFailure, actVerbAnswer, readyContract, safariDevContract } from "./fixtures/engine-answers";
import { solidPng } from "./fixtures/png";
import { rgbaPng } from "./fixtures/png-alpha";

import type * as ActModule from "../lib/act";
import type * as OpenModule from "../tools/open";

const engineCalls = vi.hoisted(() => [] as string[][]);
const opens = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  answer: null as null | ((args: Record<string, unknown>) => string),
}));

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      engineCalls.push(cli);

      return actVerbAnswer(actFailure(cli[0], { name: "NoSession", message: "no live session answers in this cell", code: "E_NO_SESSION" }), "extension_eval");
    },
  };
});

vi.mock("../tools/open", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenModule>();

  return {
    ...actual,
    handler: async (args: Record<string, unknown>) => {
      opens.calls.push(args);

      return opens.answer ? opens.answer(args) : openRefusal("no-session", "E_NO_SESSION", "no live session answers in this cell");
    },
  };
});

function openRefusal(status: string, code: string, message: string, hint?: string): string {
  return JSON.stringify({ ok: false, command: "extension_open", status, error: { code, name: code, message }, ...(hint ? { hint } : {}) });
}

const screenshot = await import("../tools/screenshot");

const GECKO_UUID = "1e5c8097-57a9-4052-bd54-d5d37a7086de";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  engineCalls.length = 0;
  opens.calls.length = 0;
  opens.answer = null;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function project(browser: string, contract: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-screenshot-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Shot",
    version: "1.0.0",
    action: { default_popup: "action/index.html" },
    options_ui: { page: "options/index.html" },
    side_panel: { default_path: "sidebar/index.html" },
  };
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(dir, "dist", browser), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", browser, "manifest.json"), JSON.stringify(manifest));
  const ready = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(ready), { recursive: true });
  fs.writeFileSync(ready, JSON.stringify({ ...contract, distPath: path.join(dir, "dist", browser) }));

  return dir;
}

function patchContract(dir: string, browser: string, extra: Record<string, unknown>): void {
  const ready = readyContractPath(dir, browser);
  fs.writeFileSync(ready, JSON.stringify({ ...JSON.parse(fs.readFileSync(ready, "utf8")), ...extra }));
}

function extensionIdOf(dir: string, browser: string): string {
  return unpackedExtensionId(path.join(dir, "dist", browser));
}

async function chromeSession(targets: (id: string) => Array<{ id: string; type: string; url: string }>) {
  const dir = project("chrome", readyContract("dev", "chrome"));
  const id = extensionIdOf(dir, "chrome");
  const chrome = await fakeChrome(targets(id));
  patchContract(dir, "chrome", { cdpPort: chrome.port });

  return { dir, id, chrome };
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(file);

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

interface FakeChrome {
  port: number;
  methods: string[];
  overrides: Array<Record<string, unknown>>;
  alpha: boolean;
}

async function fakeChrome(targets: Array<{ id: string; type: string; url: string }>): Promise<FakeChrome> {
  const state: FakeChrome = { port: 0, methods: [], overrides: [], alpha: false };
  let metrics: { width: number; height: number; deviceScaleFactor: number } | null = null;
  const server = http.createServer((req, res) => {
    const base = `ws://127.0.0.1:${state.port}/devtools`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url === "/json/version"
          ? { Browser: "Chrome/150", webSocketDebuggerUrl: `${base}/browser/b` }
          : targets.map((t) => ({ ...t, title: t.url, webSocketDebuggerUrl: `${base}/page/${t.id}` })),
      ),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      state.methods.push(message.method);
      let result: Record<string, unknown> = {};

      if (message.method === "Target.attachToTarget") result = { sessionId: `S-${String(message.params?.targetId)}` };

      if (message.method === "Emulation.setDeviceMetricsOverride") {
        state.overrides.push(message.params ?? {});
        metrics = message.params as typeof metrics;
      }

      if (message.method === "Emulation.clearDeviceMetricsOverride") metrics = null;

      if (message.method === "Page.getLayoutMetrics") {
        result = { cssLayoutViewport: { clientWidth: 640, clientHeight: 480 } };
      }

      if (message.method === "Page.captureScreenshot") {
        const scale = metrics?.deviceScaleFactor || 1;
        const make = state.alpha ? rgbaPng : solidPng;
        const png = make((metrics?.width ?? 640) * scale, (metrics?.height ?? 480) * scale);
        result = { data: png.toString("base64") };
      }

      socket.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  );

  return state;
}

interface FakeFirefox {
  port: number;
  captures: Array<Record<string, unknown>>;
}

async function fakeFirefox(tabs: Array<{ url: string; selected?: boolean }>): Promise<FakeFirefox> {
  const state: FakeFirefox = { port: 0, captures: [] };
  const server = net.createServer((socket) => {
    const decoder = new RdpPacketDecoder();
    socket.write(encodeRdpPacket({ from: "root", applicationType: "browser" }));
    socket.on("data", (chunk) => {
      for (const packet of decoder.push(Buffer.from(chunk))) {
        if (packet.type === "getRoot") {
          socket.write(encodeRdpPacket({ from: "root", screenshotActor: "server1.conn1.screenshotActor7" }));
        } else if (packet.type === "listTabs") {
          socket.write(
            encodeRdpPacket({
              from: "root",
              tabs: tabs.map((t, i) => ({ actor: `tab${i}`, browsingContextID: 100 + i, title: t.url, ...t })),
            }),
          );
        } else if (packet.type === "capture") {
          const args = packet.args as { snapshotScale?: number; rect?: { width: number; height: number } };
          state.captures.push(args);
          const scale = args.snapshotScale;
          const data =
            typeof scale === "number"
              ? `data:image/png;base64,${solidPng((args.rect?.width ?? 1366) * scale, (args.rect?.height ?? 683) * scale).toString("base64")}`
              : null;
          socket.write(
            encodeRdpPacket({
              from: "server1.conn1.screenshotActor7",
              value: {
                data,
                filename: "Screen Shot.png",
                messages: data ? [] : [{ level: "error", text: "Error creating the image. The resulting image was probably too large." }],
              },
            }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return state;
}

async function fakeSafari(url: string): Promise<{ port: number; routes: string[] }> {
  const state = { port: 0, routes: [] as string[] };
  const server = http.createServer((req, res) => {
    state.routes.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        value: String(req.url).endsWith("/screenshot") ? solidPng(1024, 768).toString("base64") : url,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return state;
}

const run = async (args: Parameters<typeof screenshot.handler>[0]) => JSON.parse(await screenshot.handler(args));

describe("extension_screenshot on Chromium captures the page over CDP", () => {
  it("writes the open popup's pixels under the session folder and answers its path and size", async () => {
    const { dir, id, chrome } = await chromeSession((extensionId) => [
      { id: "W1", type: "page", url: "https://example.com/" },
      { id: "P1", type: "page", url: `chrome-extension://${extensionId}/action/index.html` },
    ]);

    const out = await run({ projectPath: dir, browser: "chrome", context: "popup" });

    expect(out.ok).toBe(true);
    expect(out.value.path.startsWith(path.join(browserArtifactsDir(dir, "chrome"), "screenshots"))).toBe(true);
    expect(pngSize(out.value.path)).toEqual({ width: 640, height: 480 });
    expect(out.value).toMatchObject({ width: 640, height: 480, transport: "cdp" });
    expect(out.value.url).toBe(`chrome-extension://${id}/action/index.html`);
    expect(chrome.methods).toContain("Page.captureScreenshot");
    expect(chrome.methods).not.toContain("Page.bringToFront");
    expect(chrome.methods).not.toContain("Target.activateTarget");
  });

  it("renders at the asked viewport and scale, then gives the page its own size back, at the asked path", async () => {
    const { dir, chrome } = await chromeSession(() => [{ id: "W1", type: "page", url: "https://example.com/" }]);
    const file = path.join(dir, "shots", "home.png");

    const out = await run({ projectPath: dir, browser: "chrome", url: "example.com", width: 400, height: 300, deviceScaleFactor: 2, path: file });

    expect(out.ok).toBe(true);
    expect(out.value.path).toBe(file);
    expect(pngSize(file)).toEqual({ width: 800, height: 600 });
    expect(chrome.overrides[0]).toMatchObject({ width: 400, height: 300, deviceScaleFactor: 2, mobile: false });
    expect(chrome.methods.indexOf("Emulation.clearDeviceMetricsOverride")).toBeGreaterThan(
      chrome.methods.indexOf("Page.captureScreenshot"),
    );
  });

  it("518: opens a closed sidebar the way extension_open does, captures it and says opened: true", async () => {
    let targets: Array<{ id: string; type: string; url: string }> = [];
    const { dir, id } = await chromeSession((extensionId) => (targets = [{ id: "P1", type: "page", url: `chrome-extension://${extensionId}/action/index.html` }]));

    opens.answer = () => {
      targets.push({ id: "S1", type: "page", url: `chrome-extension://${id}/sidebar/index.html` });

      return JSON.stringify({ ok: true, command: "extension_open", status: "ok", value: { surface: "sidebar", opened: true } });
    };

    const out = await run({ projectPath: dir, browser: "chrome", context: "sidebar" });

    expect(opens.calls).toEqual([{ projectPath: dir, browser: "chrome", surface: "sidebar", timeout: undefined }]);
    expect(out.ok).toBe(true);
    expect(out.value.opened).toBe(true);
    expect(out.value.url).toBe(`chrome-extension://${id}/sidebar/index.html`);
    expect(out.warnings.join(" ")).toContain('opened it the way extension_open surface: "sidebar" does');
  });

  it("518: refuses with the open's own reason when the closed sidebar does not open, writing nothing", async () => {
    const { dir, chrome } = await chromeSession((extensionId) => [
      { id: "P1", type: "page", url: `chrome-extension://${extensionId}/action/index.html` },
    ]);
    opens.answer = () =>
      openRefusal("surface-did-not-open", "E_SURFACE_DID_NOT_OPEN", "The engine reported the sidebar as opened, but no document for it appeared within 3s.", "Retry with asTab: true to render the surface document in a tab instead.");

    const out = await run({ projectPath: dir, browser: "chrome", context: "sidebar" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("surface-did-not-open");
    expect(out.error.code).toBe("E_SURFACE_DID_NOT_OPEN");
    expect(out.error.message).toContain("The sidebar was not open (No open page at");
    expect(out.error.message).toContain("no document for it appeared within 3s");
    expect(out.hint).toBe("Retry with asTab: true to render the surface document in a tab instead.");
    expect(out.value).toMatchObject({ surface: "sidebar", opened: false });
    expect(chrome.methods).not.toContain("Page.captureScreenshot");
    expect(fs.existsSync(path.join(browserArtifactsDir(dir, "chrome"), "screenshots"))).toBe(false);
  });

  it("518: never opens a surface the manifest does not declare", async () => {
    const { dir } = await chromeSession(() => []);

    const out = await run({ projectPath: dir, browser: "chrome", context: "newtab" });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(opens.calls).toEqual([]);
  });

  it("asks which page when several web pages are open and no url names one", async () => {
    const { dir } = await chromeSession(() => [
      { id: "W1", type: "page", url: "https://example.com/" },
      { id: "W2", type: "page", url: "https://example.org/" },
    ]);

    const out = await run({ projectPath: dir, browser: "chrome" });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_AMBIGUOUS_TARGET");
    expect(out.value.matchingTargets.map((t: { url: string }) => t.url)).toEqual(["https://example.com/", "https://example.org/"]);
  });

  it("says there is no session when the ready contract has no debug port", async () => {
    const dir = project("chrome", readyContract("dev", "chrome"));

    const out = await run({ projectPath: dir, browser: "chrome", timeout: 1000 });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_NO_SESSION");
  });
});

describe("extension_screenshot on Firefox captures the tab over the debugger protocol", () => {
  it("captures the options page from the tab showing it, passing the scale Firefox needs", async () => {
    const firefox = await fakeFirefox([
      { url: "https://example.com/", selected: true },
      { url: `moz-extension://${GECKO_UUID}/options/index.html` },
    ]);
    const dir = project("firefox", readyContract("dev", "firefox", { rdpPort: firefox.port }));

    const out = await run({ projectPath: dir, browser: "firefox", context: "options" });

    expect(out.ok).toBe(true);
    expect(firefox.captures[0]).toMatchObject({ browsingContextID: 101, snapshotScale: 1 });
    expect(pngSize(out.value.path)).toEqual({ width: 1366, height: 683 });
    expect(out.value).toMatchObject({ width: 1366, height: 683, transport: "rdp", url: `moz-extension://${GECKO_UUID}/options/index.html` });
  });

  it("crops to width and height at the asked scale on the selected tab", async () => {
    const firefox = await fakeFirefox([{ url: "https://example.org/" }, { url: "https://example.com/", selected: true }]);
    const dir = project("firefox", readyContract("dev", "firefox", { rdpPort: firefox.port }));

    const out = await run({ projectPath: dir, browser: "firefox", width: 300, height: 200, deviceScaleFactor: 2 });

    expect(out.ok).toBe(true);
    expect(firefox.captures[0]).toMatchObject({ browsingContextID: 101, snapshotScale: 2, rect: { left: 0, top: 0, width: 300, height: 200 } });
    expect(pngSize(out.value.path)).toEqual({ width: 600, height: 400 });
  });

  it("518: opens a sidebar no tab shows as the real panel, and refuses with the open's reason when that fails, instead of capturing another page", async () => {
    const firefox = await fakeFirefox([{ url: "https://example.com/", selected: true }]);
    const dir = project("firefox", readyContract("dev", "firefox", { rdpPort: firefox.port }));

    const out = await run({ projectPath: dir, browser: "firefox", context: "sidebar" });

    expect(opens.calls).toEqual([{ projectPath: dir, browser: "firefox", surface: "sidebar", timeout: undefined }]);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_NO_SESSION");
    expect(out.error.message).toContain("sidebar/index.html");
    expect(out.error.message).toContain("no live session answers in this cell");
    expect(engineCalls.map((cli) => cli[0])).toEqual(["eval"]);
    expect(firefox.captures).toHaveLength(0);
  });

  it("518: opens a closed options page as a tab on Firefox, since the debugger protocol captures tabs, then captures it", async () => {
    const tabs: Array<{ url: string; selected?: boolean }> = [{ url: "https://example.com/", selected: true }];
    const firefox = await fakeFirefox(tabs);
    const dir = project("firefox", readyContract("dev", "firefox", { rdpPort: firefox.port }));

    opens.answer = () => {
      tabs.push({ url: `moz-extension://${GECKO_UUID}/options/index.html` });

      return JSON.stringify({ ok: true, command: "extension_open", status: "navigated", value: { renderedAsTab: { surface: "options" } } });
    };

    const out = await run({ projectPath: dir, browser: "firefox", context: "options" });

    expect(opens.calls).toEqual([{ projectPath: dir, browser: "firefox", surface: "options", timeout: undefined, asTab: true }]);
    expect(out.ok).toBe(true);
    expect(out.value).toMatchObject({ opened: true, transport: "rdp", url: `moz-extension://${GECKO_UUID}/options/index.html` });
    expect(firefox.captures).toHaveLength(1);
  });
});

describe("extension_screenshot on Safari captures web pages over WebDriver only", () => {
  it("captures the automation window's page", async () => {
    const safari = await fakeSafari("https://example.com/");
    const dir = project("safari", safariDevContract({ port: safari.port, sessionId: "S-9" }));

    const out = await run({ projectPath: dir, browser: "safari", url: "example.com" });

    expect(out.ok).toBe(true);
    expect(safari.routes).toContain("GET /session/S-9/screenshot");
    expect(out.value).toMatchObject({ width: 1024, height: 768, transport: "webdriver", url: "https://example.com/" });
  });

  it("refuses an extension surface with an honest code and touches no window", async () => {
    const safari = await fakeSafari("https://example.com/");
    const dir = project("safari", safariDevContract({ port: safari.port, sessionId: "S-9" }));

    const out = await run({ projectPath: dir, browser: "safari", context: "popup" });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_SURFACE_NOT_CAPTURABLE");
    expect(safari.routes).toEqual([]);
  });
});

describe("extension_screenshot store captures at the store's preset as a 24-bit PNG under store/screenshots", () => {
  it("renders the popup at 1280x800 at 1x, flattens the alpha channel, files it as store/screenshots/chrome/01.png and names the sync-listing pickup", async () => {
    const { dir, chrome } = await chromeSession((extensionId) => [{ id: "P1", type: "page", url: `chrome-extension://${extensionId}/action/index.html` }]);
    chrome.alpha = true;

    const out = await run({ projectPath: dir, browser: "chrome", context: "popup", store: "chrome" });

    expect(out.ok).toBe(true);
    expect(chrome.overrides[0]).toMatchObject({ width: 1280, height: 800, deviceScaleFactor: 1 });
    expect(out.value.path).toBe(path.join(dir, "store", "screenshots", "chrome", "01.png"));
    expect(pngSize(out.value.path)).toEqual({ width: 1280, height: 800 });
    expect(fs.readFileSync(out.value.path)[25]).toBe(2);
    expect(out.value.files).toEqual([{ store: "chrome", path: out.value.path, width: 1280, height: 800, clears: true }]);
    expect(out.hint).toContain("clears the screenshot row of the Chrome Web Store");
    expect(out.hint).toContain('extension_submit action:"sync-listing" browsers:["chrome"] picks the files up from store/screenshots/chrome/');
  });

  it("refuses a size or a pixel ratio beside store, and a store it does not know, before any capture", async () => {
    const { dir, chrome } = await chromeSession(() => [{ id: "W1", type: "page", url: "https://example.com/" }]);

    const sized = await run({ projectPath: dir, browser: "chrome", url: "example.com", store: "edge", width: 640, height: 480 });

    expect(sized.ok).toBe(false);
    expect(sized.error.code).toBe("E_BAD_REQUEST");
    expect(sized.error.message).toContain("chrome, edge and firefox 1280x800 at 1x; safari 1440x900 at 2x");

    const scaled = await run({ projectPath: dir, browser: "chrome", url: "example.com", store: "safari", deviceScaleFactor: 2 });

    expect(scaled.ok).toBe(false);
    expect(scaled.error.message).toContain("omit width, height and deviceScaleFactor with store");

    const unknown = await run({ projectPath: dir, browser: "chrome", url: "example.com", store: "opera" });

    expect(unknown.ok).toBe(false);
    expect(unknown.error.message).toContain("store must be one of chrome, firefox, edge, safari, all");
    expect(chrome.methods.filter((m) => m === "Page.captureScreenshot")).toHaveLength(0);
  });

  it("crops the Firefox site tab, not the selected about: page, to 1280x800 at 1x into store/screenshots/firefox/01.png and answers the row it clears", async () => {
    const firefox = await fakeFirefox([{ url: "about:addons", selected: true }, { url: "https://example.com/" }]);
    const dir = project("firefox", readyContract("dev", "firefox", { rdpPort: firefox.port }));

    const out = await run({ projectPath: dir, browser: "firefox", store: "firefox" });

    expect(out.ok).toBe(true);
    expect(out.value.url).toBe("https://example.com/");
    expect(firefox.captures[0]).toMatchObject({ rect: { left: 0, top: 0, width: 1280, height: 800 }, snapshotScale: 1 });
    expect(out.value.path).toBe(path.join(dir, "store", "screenshots", "firefox", "01.png"));
    expect(pngSize(out.value.path)).toEqual({ width: 1280, height: 800 });
    expect(out.value.files[0]).toMatchObject({ store: "firefox", clears: true });
    expect(out.hint).toContain("clears the screenshot row of Firefox Add-ons");
  });
});
