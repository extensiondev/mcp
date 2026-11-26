// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";
import { readyContract } from "./fixtures/engine-answers";
import { onlyFakeChromeFetch, startFakeChrome, type FakeChrome, type FakeCommand } from "./fixtures/fake-chrome";
import { solidPng, tiledPng } from "./fixtures/png";

const screenshot = await import("../tools/screenshot");

const EXTENSION_ID = "gilebldjbffpkjnbciipghplepdmpjde";
const WINDOW_ID = 77;
const PAGE = { id: "PAGE1", type: "page", url: "https://rebeccat.example/toast" };
const WORKER = { id: "SW1", type: "service_worker", url: `chrome-extension://${EXTENSION_ID}/background/service_worker.js` };

let dir: string;
let chrome: FakeChrome | null;

function methods(): string[] {
  return (chrome?.commands ?? []).map((c) => (c.method === "Runtime.evaluate" ? `eval:${String(c.params.expression)}` : c.method));
}

function evaluated(fragment: string): FakeCommand[] {
  return (chrome?.commands ?? []).filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes(fragment));
}

async function browser(visibility: string, matched = 1, tiledShots = 0): Promise<void> {
  let shown = visibility === "visible";
  let overridden = false;
  let tiledLeft = tiledShots;

  chrome = await startFakeChrome([PAGE, WORKER], (command) => {
    if (command.method === "Browser.getWindowForTarget") return { windowId: WINDOW_ID };

    if (command.method === "Runtime.evaluate") {
      const expression = String(command.params.expression);

      if (expression === "document.visibilityState") return { result: { type: "string", value: shown ? "visible" : "hidden" } };

      if (expression.includes(`chrome.tabs.query({ windowId: ${WINDOW_ID} })`)) {
        if (matched !== 1) return { result: { type: "object", value: { matched, readable: true } } };

        shown = true;

        return { result: { type: "object", value: { matched: 1, shownId: 11 } } };
      }

      if (expression.includes("document.getAnimations()")) return { result: { type: "boolean", value: shown } };

      if (expression.includes("chrome.tabs.update(11, { active: true })")) {
        shown = false;

        return { result: { type: "boolean", value: true } };
      }
    }

    if (command.method === "Emulation.setDeviceMetricsOverride") overridden = true;
    if (command.method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 756, clientHeight: 513 } };

    if (command.method === "Page.captureScreenshot") {
      if (overridden && tiledLeft > 0) {
        tiledLeft -= 1;

        return { data: tiledPng(1280, 800, 756, 513).toString("base64") };
      }

      return { data: (overridden ? tiledPng(1280, 800, 1280, 800) : solidPng(shown ? 640 : 320, 480)).toString("base64") };
    }

    return undefined;
  });

  vi.stubGlobal("fetch", onlyFakeChromeFetch(() => chrome!.port));
  const file = readyContractPath(dir, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract("dev", "chrome", { extensionId: EXTENSION_ID, cdpPort: chrome.port, distPath: path.join(dir, "dist", "chrome") })));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-hidden-"));
  chrome = null;
  vi.stubGlobal("fetch", () => {
    throw new Error("these specs reach only their fake browser");
  });
});

afterEach(async () => {
  await chrome?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("extension_screenshot of a hidden tab shows it for the capture instead of freezing its animations mid-way", () => {
  it("shows the tab in its window, lets its animations finish, captures, switches back, and says so", async () => {
    await browser("hidden");

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id }));

    expect(result.status).toBe("captured");
    expect(result.value.width).toBe(640);
    expect(result.value.hiddenTab).toEqual({ hidden: true, shown: true, restored: true, animationsFinished: true });
    expect(result.warnings.join(" ")).toContain("made it the shown tab of its window for the capture, let its running animations finish, and switched back");

    const order = methods();
    const showAt = order.findIndex((m) => m.includes("chrome.tabs.query({ active: true"));
    const settleAt = order.findIndex((m) => m.includes("requestAnimationFrame"));
    const captureAt = order.indexOf("Page.captureScreenshot");
    const restoreAt = order.findIndex((m) => m.includes("chrome.tabs.update(11"));
    expect(showAt).toBeGreaterThan(-1);
    expect(showAt).toBeLessThan(settleAt);
    expect(settleAt).toBeLessThan(captureAt);
    expect(captureAt).toBeLessThan(restoreAt);
    expect(evaluated("chrome.tabs.query({ windowId")[0]!.sessionId).toBe("S-SW1");
    expect(String(evaluated("chrome.tabs.query({ windowId")[0]!.params.expression)).toContain(JSON.stringify(PAGE.url));
    expect(order).not.toContain("Page.bringToFront");
    expect(order).not.toContain("Target.activateTarget");
  }, 20_000);

  it("switches no tab and adds no note for a page that is already shown", async () => {
    await browser("visible");

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id }));

    expect(result.status).toBe("captured");
    expect(result.value).not.toHaveProperty("hiddenTab");
    expect(evaluated("chrome.tabs")).toHaveLength(0);
    expect(result.warnings.join(" ")).not.toContain("hidden tab");
  }, 20_000);

  it("never files the page's old layout tiled across the asked viewport, and names the fresh tab that lays it out", async () => {
    await browser("hidden", 1, 2);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, store: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_CAPTURE_FAILED");
    expect(result.error.message).toContain("the page's 756 px layout repeated across the 1280 px viewport");
    expect(result.hint).toContain(`extension_open {url: "${PAGE.url}", newTab: true}`);
    expect(chrome!.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, "store"))).toBe(false);
  }, 20_000);

  it("captures again after two frames when only the first shot repeats the old layout", async () => {
    await browser("hidden", 1, 1);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, width: 1280, height: 800, deviceScaleFactor: 1 }));

    expect(result.status).toBe("captured");
    expect(result.value).toMatchObject({ width: 1280, height: 800 });
    expect(chrome!.commands.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(2);
  }, 20_000);

  it("says the image may show a mid-animation state when it cannot tell which tab to show", async () => {
    await browser("hidden", 2);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id }));

    expect(result.status).toBe("captured");
    expect(result.value.hiddenTab).toEqual({ hidden: true, shown: false, reason: `2 tabs of the page's window show ${PAGE.url}, so this tool could not tell which one to show` });
    expect(result.warnings.join(" ")).toContain("the image may show a mid-animation state");
    expect(result.warnings.join(" ")).toContain("extension_open foreground: true");
    expect(evaluated("chrome.tabs.update(11")).toHaveLength(0);
  }, 20_000);
});
