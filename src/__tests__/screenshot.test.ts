import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { unpackedExtensionId } from "../lib/extension-identity";
import { encodeRdpPacket, RdpPacketDecoder } from "../lib/rdp";
import { browserArtifactsDir, readyContractPath } from "../lib/session-paths";
import { readyContract, safariDevContract } from "./fixtures/engine-answers";
import { solidPng } from "./fixtures/png";

const screenshot = await import("../tools/screenshot");

const GECKO_UUID = "1e5c8097-57a9-4052-bd54-d5d37a7086de";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
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
}

async function fakeChrome(targets: Array<{ id: string; type: string; url: string }>): Promise<FakeChrome> {
  const state: FakeChrome = { port: 0, methods: [], overrides: [] };
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
        const png = solidPng((metrics?.width ?? 640) * scale, (metrics?.height ?? 480) * scale);
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

  it("refuses a surface that is not open and names extension_open, writing nothing", async () => {
    const { dir, chrome } = await chromeSession((extensionId) => [
      { id: "P1", type: "page", url: `chrome-extension://${extensionId}/action/index.html` },
    ]);

    const out = await run({ projectPath: dir, browser: "chrome", context: "sidebar" });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_NO_TARGET");
    expect(out.hint).toContain("extension_open");
    expect(chrome.methods).not.toContain("Page.captureScreenshot");
    expect(fs.existsSync(path.join(browserArtifactsDir(dir, "chrome"), "screenshots"))).toBe(false);
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

  it("says a sidebar no tab shows cannot be reached, instead of capturing another page", async () => {
    const firefox = await fakeFirefox([{ url: "https://example.com/", selected: true }]);
    const dir = project("firefox", readyContract("dev", "firefox", { rdpPort: firefox.port }));

    const out = await run({ projectPath: dir, browser: "firefox", context: "sidebar" });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_NO_TARGET");
    expect(out.error.message).toContain("sidebar/index.html");
    expect(firefox.captures).toHaveLength(0);
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
