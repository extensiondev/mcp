import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unpackedExtensionId } from "../lib/extension-identity";
import { encodeRdpPacket, RdpPacketDecoder } from "../lib/rdp";
import { readyContractPath } from "../lib/session-paths";
import { readyContract, safariDevContract } from "./fixtures/engine-answers";
import { onlyFakeChromeFetch, startFakeChrome, type FakeChrome } from "./fixtures/fake-chrome";
import { solidPng } from "./fixtures/png";

const screenshot = await import("../tools/screenshot");

const PAGE = { id: "PAGE1", type: "page", url: "https://rebeccat.example/toast" };
const CHROME_VERSION = "142.0.7444.59";

let dir: string;
let chrome: FakeChrome | null;
const closers: Array<() => Promise<void>> = [];

function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(file);

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function writeContract(browser: string, contract: Record<string, unknown>): void {
  const file = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...contract, distPath: path.join(dir, "dist", browser) }));
}

async function chromium(browser = "chrome", extraTargets: Array<{ id: string; type: string; url: string }> = [], product: string | null = `Chrome/${CHROME_VERSION}`): Promise<void> {
  let metrics: { width: number; height: number; deviceScaleFactor: number } | null = null;

  chrome = await startFakeChrome([PAGE, ...extraTargets], (command) => {
    if (command.method === "Emulation.setDeviceMetricsOverride") metrics = command.params as typeof metrics;
    if (command.method === "Emulation.clearDeviceMetricsOverride") metrics = null;
    if (command.method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 640, clientHeight: 480 } };
    if (command.method === "Runtime.evaluate") return { result: { type: "string", value: "visible" } };
    if (command.method === "Browser.getVersion") return product ? { protocolVersion: "1.3", product, userAgent: `Mozilla/5.0 ${product}` } : {};

    if (command.method === "Page.captureScreenshot") {
      const scale = metrics?.deviceScaleFactor || 1;

      return { data: solidPng((metrics?.width ?? 640) * scale, (metrics?.height ?? 480) * scale).toString("base64") };
    }

    return undefined;
  });

  vi.stubGlobal("fetch", onlyFakeChromeFetch(() => chrome!.port));
  writeContract(browser, readyContract("dev", browser, { cdpPort: chrome.port }));
}

interface FakeSafari {
  port: number;
  routes: Array<{ route: string; body: unknown }>;
}

async function safari(browserVersion: string | null): Promise<FakeSafari> {
  const state: FakeSafari = { port: 0, routes: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });

    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const route = `${req.method} ${String(req.url).replace(/^\/session\/S-9/, "")}`;
      state.routes.push({ route, body });
      let value: unknown = "https://rebeccat.example/toast";

      if (route === "GET ") value = browserVersion ? { capabilities: { browserName: "Safari", browserVersion } } : { capabilities: { browserName: "Safari" } };
      if (route === "POST /execute/sync") value = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";
      if (route === "GET /screenshot") value = solidPng(1024, 768).toString("base64");

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  vi.unstubAllGlobals();
  writeContract("safari", safariDevContract({ port: state.port, sessionId: "S-9" }));

  return state;
}

async function firefox(version: string | null): Promise<{ port: number; asked: string[] }> {
  const state = { port: 0, asked: [] as string[] };
  const server = net.createServer((socket) => {
    const decoder = new RdpPacketDecoder();
    socket.write(encodeRdpPacket({ from: "root", applicationType: "browser" }));
    socket.on("data", (chunk) => {
      for (const packet of decoder.push(Buffer.from(chunk))) {
        state.asked.push(`${String(packet.to)}:${String(packet.type)}`);

        if (packet.type === "getRoot") {
          socket.write(encodeRdpPacket({ from: "root", screenshotActor: "server1.conn1.screenshotActor7", deviceActor: "server1.conn1.device2" }));
        } else if (packet.type === "getDescription") {
          socket.write(encodeRdpPacket({ from: "server1.conn1.device2", value: version ? { version, platformversion: version, apptype: "firefox" } : { apptype: "firefox" } }));
        } else if (packet.type === "listTabs") {
          socket.write(encodeRdpPacket({ from: "root", tabs: [{ actor: "tab0", browsingContextID: 100, title: "toast", url: "https://rebeccat.example/toast", selected: true }] }));
        } else if (packet.type === "capture") {
          socket.write(encodeRdpPacket({ from: "server1.conn1.screenshotActor7", value: { data: `data:image/png;base64,${solidPng(1366, 683).toString("base64")}`, filename: "Screen Shot.png", messages: [] } }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  vi.unstubAllGlobals();
  writeContract("firefox", readyContract("dev", "firefox", { rdpPort: state.port }));

  return state;
}

const run = async (args: Parameters<typeof screenshot.handler>[0]) => JSON.parse(await screenshot.handler(args));
const index = (browser: string) => JSON.parse(fs.readFileSync(path.join(dir, "captures", browser, "captures.json"), "utf8"));
const door = (browser: string) => `One call per surface; extension_publish action:"sync-captures" browsers:["${browser}"] sends captures/${browser}/ to the public build page after a workspace owner approves.`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-capture-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const manifest = { manifest_version: 3, name: "Shot", version: "1.0.0", action: { default_popup: "action/index.html" } };
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(dir, "dist", "chrome"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "chrome", "manifest.json"), JSON.stringify(manifest));
  chrome = null;
  vi.stubGlobal("fetch", () => {
    throw new Error("these specs reach only their fake browser");
  });
});

afterEach(async () => {
  await chrome?.close();
  for (const close of closers.splice(0)) await close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("extension_screenshot browserCapture files the capture under captures/<browser>/ with the live browser's version", () => {
  it("chrome writes captures/chrome/page-01.png then page-02.png, records Chrome 142.0.7444.59 and the surface, and names the sync call", async () => {
    await chromium();

    const first = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", browserCapture: true });

    expect(first.ok).toBe(true);
    expect(first.status).toBe("captured");
    expect(first.value.path).toBe(path.join(dir, "captures", "chrome", "page-01.png"));
    expect(pngSize(first.value.path)).toEqual({ width: 640, height: 480 });
    expect(first.value).toMatchObject({ browser: "chrome", browserCapture: true, surface: "page", folder: "captures/chrome", capturedIn: { name: "Chrome", version: CHROME_VERSION }, transport: "cdp" });
    expect(chrome!.commands.some((c) => c.method === "Browser.getVersion")).toBe(true);
    expect(first.hint).toBe(`${first.value.path} (640 x 480 pixels) is a Chrome 142 capture of the page. ${door("chrome")}`);
    expect(first.warnings).toEqual([]);

    const second = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", browserCapture: true, width: 1024, height: 768 });

    expect(second.value.path).toBe(path.join(dir, "captures", "chrome", "page-02.png"));
    expect(pngSize(second.value.path)).toEqual({ width: 1024, height: 768 });
    expect(index("chrome")).toEqual({
      browser: "chrome",
      capturedIn: { name: "Chrome", version: CHROME_VERSION },
      captures: [
        { file: "page-01.png", surface: "page", width: 640, height: 480, capturedAt: expect.any(String) },
        { file: "page-02.png", surface: "page", width: 1024, height: 768, capturedAt: expect.any(String) },
      ],
    });

    expect(fs.readdirSync(path.join(dir, "captures", "chrome")).sort()).toEqual(["captures.json", "page-01.png", "page-02.png"]);
  });

  it("the popup is numbered on its own and the hint says a capture of the popup", async () => {
    const extensionId = unpackedExtensionId(path.join(dir, "dist", "chrome"));
    await chromium("chrome", [{ id: "POP1", type: "page", url: `chrome-extension://${extensionId}/action/index.html` }]);

    const out = await run({ projectPath: dir, browser: "chrome", context: "popup", browserCapture: true });

    expect(out.ok).toBe(true);
    expect(out.value.path).toBe(path.join(dir, "captures", "chrome", "popup-01.png"));
    expect(out.value.surface).toBe("popup");
    expect(out.hint).toBe(`${out.value.path} (640 x 480 pixels) is a Chrome 142 capture of the popup. ${door("chrome")}`);
    expect(index("chrome").captures).toEqual([{ file: "popup-01.png", surface: "popup", width: 640, height: 480, capturedAt: expect.any(String) }]);
  });

  it("refuses browserCapture beside store, and beside path, before any capture", async () => {
    await chromium();

    const beside = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", browserCapture: true, store: "chrome" });

    expect(beside.ok).toBe(false);
    expect(beside.error.code).toBe("E_BAD_REQUEST");
    expect(beside.error.message).toContain("store and browserCapture are two different files");

    const pathed = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", browserCapture: true, path: "shots/" });

    expect(pathed.error.code).toBe("E_BAD_REQUEST");
    expect(pathed.error.message).toContain("omit path with it");
    expect(chrome!.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "captures"))).toBe(false);
  });

  it("refuses a session on a browser the build pages do not show, naming the four", async () => {
    await chromium("brave");

    const out = await run({ projectPath: dir, browser: "brave", url: "rebeccat", browserCapture: true });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("chrome, firefox, edge, safari, and this session runs brave");
    expect(chrome!.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(0);
  });

  it("falls back to the debug port's /json/version when Browser.getVersion answers no product", async () => {
    await chromium("chrome", [], null);

    const out = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", browserCapture: true });

    expect(out.ok).toBe(true);
    expect(out.value.capturedIn).toEqual({ name: "Chrome", version: "151" });
    expect(out.hint.startsWith(`${out.value.path} (640 x 480 pixels) is a Chrome 151 capture of the page.`)).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it("says in a warning when the browser answers no version at all, and records no capturedIn", async () => {
    await firefox(null);

    const out = await run({ projectPath: dir, browser: "firefox", url: "rebeccat", browserCapture: true });

    expect(out.ok).toBe(true);
    expect(out.value.capturedIn).toBeUndefined();
    expect(out.hint.startsWith(`${out.value.path} (1366 x 683 pixels) is a Firefox capture of the page.`)).toBe(true);
    expect(out.warnings.join("\n")).toContain("The firefox session did not answer its version, so captures/firefox/captures.json records no capturedIn");
    expect(index("firefox").capturedIn).toBeUndefined();
  });

  it("safari reads browserVersion from safaridriver's session capabilities and files captures/safari/page-01.png", async () => {
    const driver = await safari("26.1");

    const out = await run({ projectPath: dir, browser: "safari", url: "rebeccat", browserCapture: true });

    expect(out.ok).toBe(true);
    expect(out.value.path).toBe(path.join(dir, "captures", "safari", "page-01.png"));
    expect(pngSize(out.value.path)).toEqual({ width: 1024, height: 768 });
    expect(out.value.capturedIn).toEqual({ name: "Safari", version: "26.1" });
    expect(driver.routes.some((r) => r.route === "GET ")).toBe(true);
    expect(out.hint).toBe(`${out.value.path} (1024 x 768 pixels) is a Safari 26 capture of the page. ${door("safari")}`);
    expect(index("safari")).toMatchObject({ browser: "safari", capturedIn: { name: "Safari", version: "26.1" }, captures: [{ file: "page-01.png", surface: "page" }] });
  });

  it("safari falls back to the window's user agent when the session answers no browserVersion", async () => {
    await safari(null);

    const out = await run({ projectPath: dir, browser: "safari", url: "rebeccat", browserCapture: true });

    expect(out.ok).toBe(true);
    expect(out.value.capturedIn).toEqual({ name: "Safari", version: "26.0" });
  });

  it("firefox reads the version from the device actor's getDescription over the debugger server", async () => {
    const gecko = await firefox("145.0.1");

    const out = await run({ projectPath: dir, browser: "firefox", url: "rebeccat", browserCapture: true });

    expect(out.ok).toBe(true);
    expect(out.value.path).toBe(path.join(dir, "captures", "firefox", "page-01.png"));
    expect(out.value.capturedIn).toEqual({ name: "Firefox", version: "145.0.1" });
    expect(gecko.asked).toContain("server1.conn1.device2:getDescription");
    expect(out.hint).toBe(`${out.value.path} (1366 x 683 pixels) is a Firefox 145 capture of the page. ${door("firefox")}`);
  });
});
