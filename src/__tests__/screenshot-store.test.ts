import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";
import { readyContract, safariDevContract } from "./fixtures/engine-answers";
import { onlyFakeChromeFetch, startFakeChrome, type FakeChrome } from "./fixtures/fake-chrome";
import { solidPng } from "./fixtures/png";

import type net from "node:net";

const screenshot = await import("../tools/screenshot");

const PAGE = { id: "PAGE1", type: "page", url: "https://rebeccat.example/toast" };

let dir: string;
let chrome: FakeChrome | null;
const closers: Array<() => Promise<void>> = [];

function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(file);

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function chromium(targets: Array<{ id: string; type: string; url: string }> = [PAGE]): Promise<void> {
  let metrics: { width: number; height: number; deviceScaleFactor: number } | null = null;

  chrome = await startFakeChrome(targets, (command) => {
    if (command.method === "Emulation.setDeviceMetricsOverride") metrics = command.params as typeof metrics;
    if (command.method === "Emulation.clearDeviceMetricsOverride") metrics = null;
    if (command.method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 640, clientHeight: 480 } };
    if (command.method === "Runtime.evaluate") return { result: { type: "string", value: "visible" } };

    if (command.method === "Page.captureScreenshot") {
      const scale = metrics?.deviceScaleFactor ?? 1;

      return { data: solidPng((metrics?.width ?? 640) * scale, (metrics?.height ?? 480) * scale).toString("base64") };
    }

    return undefined;
  });

  vi.stubGlobal("fetch", onlyFakeChromeFetch(() => chrome!.port));
  const file = readyContractPath(dir, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract("dev", "chrome", { cdpPort: chrome.port, distPath: path.join(dir, "dist", "chrome") })));
}

interface FakeSafari {
  port: number;
  routes: Array<{ route: string; body: unknown }>;
}

async function safari(pixelRatio: number, chromeHeight = 60): Promise<FakeSafari> {
  const state: FakeSafari = { port: 0, routes: [] };
  let rect = { width: 1024, height: 768 };
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

      if (route === "POST /window/rect") rect = { width: Number(body.width), height: Number(body.height) };
      if (route === "POST /execute/sync") value = [rect.width, rect.height - chromeHeight];
      if (route === "GET /screenshot") value = solidPng(rect.width * pixelRatio, (rect.height - chromeHeight) * pixelRatio).toString("base64");

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  vi.unstubAllGlobals();

  const file = readyContractPath(dir, "safari");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(safariDevContract({ port: state.port, sessionId: "S-9" }, { distPath: path.join(dir, "dist", "safari") })));

  return state;
}

const run = async (args: Parameters<typeof screenshot.handler>[0]) => JSON.parse(await screenshot.handler(args));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-store-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Shot", version: "1.0.0" }));
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

describe("extension_screenshot store captures at the store's preset and files it under store/screenshots", () => {
  it("chrome renders 1280x800 at 1x into store/screenshots/chrome/01.png, then 02.png, and refuses a size beside store", async () => {
    await chromium();

    const first = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", store: "chrome" });

    expect(first.ok).toBe(true);
    expect(first.value.path).toBe(path.join(dir, "store", "screenshots", "chrome", "01.png"));
    expect(pngSize(first.value.path)).toEqual({ width: 1280, height: 800 });
    expect(chrome!.commands.find((c) => c.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({ width: 1280, height: 800, deviceScaleFactor: 1 });
    expect(first.value.files).toEqual([{ store: "chrome", path: first.value.path, width: 1280, height: 800, clears: true }]);
    expect(first.hint).toBe(
      `${first.value.path} (1280 x 800 pixels) clears the screenshot row of the Chrome Web Store. One call per view; extension_submit action:"sync-listing" browsers:["chrome"] picks the files up from store/screenshots/chrome/.`,
    );

    const second = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", store: "chrome" });

    expect(second.value.path).toBe(path.join(dir, "store", "screenshots", "chrome", "02.png"));

    const sized = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", store: "chrome", width: 640, height: 400 });

    expect(sized.ok).toBe(false);
    expect(sized.error.code).toBe("E_BAD_REQUEST");
    expect(sized.error.message).toContain("omit width, height and deviceScaleFactor with store");
    expect(fs.readdirSync(path.join(dir, "store", "screenshots", "chrome"))).toEqual(["01.png", "02.png"]);
  });

  it("refuses a browser page as a store target and writes nothing, picks a site tab over one, and still captures a browser page without store", async () => {
    await chromium([
      { id: "EXT", type: "page", url: "chrome://extensions/" },
      { id: "BLANK", type: "page", url: "about:blank" },
    ]);

    const refused = await run({ projectPath: dir, browser: "chrome", store: "chrome" });

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe("no-target");
    expect(refused.error.message).toBe("The open tabs show only browser pages (chrome://extensions/, about:blank), not the extension at work, so it is not a store listing screenshot; nothing was written under store/screenshots/.");
    expect(refused.hint).toContain('extension_open {url: "https://..."}');
    expect(fs.existsSync(path.join(dir, "store"))).toBe(false);

    const named = await run({ projectPath: dir, browser: "chrome", url: "chrome://extensions", store: "chrome" });

    expect(named.status).toBe("no-target");
    expect(named.error.message).toContain("chrome://extensions/ is a browser page");
    expect(chrome!.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(0);

    const plain = await run({ projectPath: dir, browser: "chrome", url: "chrome://extensions" });

    expect(plain.ok).toBe(true);
    expect(plain.value.url).toBe("chrome://extensions/");
    expect(plain.value.path.includes(path.join("store", "screenshots"))).toBe(false);

    chrome!.targets.push(PAGE);

    const site = await run({ projectPath: dir, browser: "chrome", store: "chrome" });

    expect(site.ok).toBe(true);
    expect(site.value.url).toBe(PAGE.url);
    expect(site.value.path).toBe(path.join(dir, "store", "screenshots", "chrome", "01.png"));
  });

  it("safari on a Chromium session renders 1440x900 at 2x into a 2880x1800 file and warns that Apple wants Safari", async () => {
    await chromium();

    const out = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", store: "safari" });

    expect(out.ok).toBe(true);
    expect(out.value.path).toBe(path.join(dir, "store", "screenshots", "safari", "01.png"));
    expect(pngSize(out.value.path)).toEqual({ width: 2880, height: 1800 });
    expect(chrome!.commands.find((c) => c.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({ width: 1440, height: 900, deviceScaleFactor: 2 });
    expect(out.value.files[0]).toMatchObject({ store: "safari", clears: true });
    expect(out.warnings.join("\n")).toContain("Apple's review wants the extension running in Safari");
  });

  it("all on a Chromium session writes the four store files from two captures and answers each path", async () => {
    await chromium();

    const out = await run({ projectPath: dir, browser: "chrome", url: "rebeccat", store: "all" });

    expect(out.ok).toBe(true);
    expect(chrome!.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(2);
    expect(out.value.files.map((f: { store: string }) => f.store)).toEqual(["chrome", "edge", "firefox", "safari"]);

    for (const file of out.value.files) {
      const size = file.store === "safari" ? { width: 2880, height: 1800 } : { width: 1280, height: 800 };

      expect(file.path).toBe(path.join(dir, "store", "screenshots", file.store, "01.png"));
      expect(pngSize(file.path)).toEqual(size);
      expect({ width: file.width, height: file.height }).toEqual(size);
      expect(file.clears).toBe(true);
    }

    const at = (store: string) => path.join(dir, "store", "screenshots", store, "01.png");

    expect(out.hint).toBe(
      `Wrote ${at("chrome")} (1280 x 800 pixels) for the Chrome Web Store, ${at("edge")} (1280 x 800 pixels) for Edge Add-ons, ${at("firefox")} (1280 x 800 pixels) for Firefox Add-ons and ${at("safari")} (2880 x 1800 pixels) for the App Store; each clears that store's screenshot row. One call per view; extension_submit action:"sync-listing" browsers:["chrome", "edge", "firefox", "safari"] picks each store's files up from store/screenshots/<store>/.`,
    );
  });

  it("all on Safari writes only the safari file and says which stores were skipped and why", async () => {
    const driver = await safari(2);

    const out = await run({ projectPath: dir, browser: "safari", url: "rebeccat", store: "all" });

    expect(out.ok).toBe(true);
    expect(out.value.files.map((f: { store: string }) => f.store)).toEqual(["safari"]);
    expect(fs.existsSync(path.join(dir, "store", "screenshots", "chrome"))).toBe(false);
    expect(out.warnings.join("\n")).toMatch(/chrome, edge, firefox were skipped/);
    expect(out.warnings.join("\n")).not.toContain("Apple's review wants");
    expect(driver.routes.filter((r) => r.route === "GET /screenshot")).toHaveLength(1);
  });
});

describe("extension_screenshot on Safari sizes the window over WebDriver and measures what comes back", () => {
  it("sets the window rect, reads the inner size, adjusts once, and files a 2880x1800 capture that clears the App Store row", async () => {
    const driver = await safari(2);

    const out = await run({ projectPath: dir, browser: "safari", url: "rebeccat", store: "safari" });

    expect(out.ok).toBe(true);
    const rects = driver.routes.filter((r) => r.route === "POST /window/rect").map((r) => r.body);

    expect(rects).toEqual([{ width: 1440, height: 900 }, { width: 1440, height: 960 }]);
    expect(driver.routes.some((r) => r.route === "POST /execute/sync")).toBe(true);
    expect(driver.routes.indexOf(driver.routes.find((r) => r.route === "GET /screenshot")!)).toBeGreaterThan(driver.routes.findIndex((r) => r.route === "POST /window/rect"));
    expect(pngSize(out.value.path)).toEqual({ width: 2880, height: 1800 });
    expect(out.value.files[0]).toMatchObject({ store: "safari", clears: true });
    expect(out.warnings.join("\n")).not.toContain("not applied on Safari");
    expect(out.warnings.join("\n")).not.toMatch(/pixel ratio/);
  });

  it("says what size Safari answered when the display's pixel ratio is not 2, instead of filing a wrong-size capture silently", async () => {
    await safari(1);

    const out = await run({ projectPath: dir, browser: "safari", url: "rebeccat", store: "safari" });

    expect(out.ok).toBe(true);
    expect(pngSize(out.value.path)).toEqual({ width: 1440, height: 900 });
    expect(out.value.files[0]).toMatchObject({ store: "safari", clears: true });
    expect(out.hint.startsWith(`${out.value.path} (1440 x 900 pixels) clears the screenshot row of the App Store. One call per view; `)).toBe(true);
    expect(out.warnings.join("\n")).toContain("Safari answered a 1440x900 image for a 1440x900 window, not 2880x1800");
  });

  it("applies plain width and height through the window rect and still refuses the popup with the same words", async () => {
    const driver = await safari(1);

    const out = await run({ projectPath: dir, browser: "safari", url: "rebeccat", width: 1280, height: 800 });

    expect(out.ok).toBe(true);
    expect(driver.routes.filter((r) => r.route === "POST /window/rect").map((r) => r.body)).toEqual([{ width: 1280, height: 800 }, { width: 1280, height: 860 }]);
    expect(out.value).toMatchObject({ width: 1280, height: 800 });
    expect(out.warnings).toEqual([]);

    const popup = await run({ projectPath: dir, browser: "safari", context: "popup", store: "safari" });

    expect(popup.ok).toBe(false);
    expect(popup.error.code).toBe("E_SURFACE_NOT_CAPTURABLE");
    expect(popup.error.message).toContain("Safari's WebDriver reaches only web pages in its automation window, so it cannot capture the popup");
  });
});
