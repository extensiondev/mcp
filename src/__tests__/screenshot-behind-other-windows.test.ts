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
import { HANG, onlyFakeChromeFetch, startFakeChrome, type FakeChrome, type FakeCommand } from "./fixtures/fake-chrome";
import { solidPng } from "./fixtures/png";

const screenshot = await import("../tools/screenshot");

const EXTENSION_ID = "gilebldjbffpkjnbciipghplepdmpjde";
const WINDOW_ID = 1945307085;
const PAGE = { id: "PAGE1", type: "page", url: "https://www.google.com/search?q=jobim" };
const WORKER = { id: "SW1", type: "service_worker", url: `chrome-extension://${EXTENSION_ID}/background/service_worker.js` };

let dir: string;
let chrome: FakeChrome | null;

function evaluated(fragment: string): FakeCommand[] {
  return (chrome?.commands ?? []).filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes(fragment));
}

async function browserWithPageBehindOtherWindows(targets = [PAGE, WORKER]): Promise<FakeChrome> {
  let shownTab = 11;

  chrome = await startFakeChrome(targets, (command) => {
    if (command.method === "Browser.getWindowForTarget") return { windowId: WINDOW_ID, bounds: { windowState: "normal" } };

    if (command.method === "Runtime.evaluate") {
      const expression = String(command.params.expression);

      if (expression.includes("chrome.tabs.create")) {
        shownTab = 99;

        return { result: { type: "object", value: { shownId: 11, blankId: 99 } } };
      }

      if (expression.includes("chrome.tabs.remove")) {
        shownTab = 11;

        return { result: { type: "boolean", value: true } };
      }
    }

    if (command.method === "Page.captureScreenshot") {
      return shownTab === 11 ? HANG : { data: solidPng(640, 480).toString("base64") };
    }

    return undefined;
  });

  session(chrome.port);

  return chrome;
}

interface Pixels {
  width: number;
  height: number;
}

async function retinaBrowserBehindOtherWindows(answerPixels: (pixels: Pixels) => Pixels = (pixels) => pixels): Promise<{ view: () => Pixels }> {
  const ratio = 2;
  let shownTab = 11;
  let view: Pixels = { width: 1200, height: 762 };
  let before: Pixels | null = null;
  let emulated: (Pixels & { deviceScaleFactor: number }) | null = null;

  chrome = await startFakeChrome([PAGE, WORKER], (command) => {
    if (command.method === "Browser.getWindowForTarget") return { windowId: WINDOW_ID, bounds: { windowState: "normal" } };

    if (command.method === "Runtime.evaluate") {
      const expression = String(command.params.expression);

      if (expression.includes("chrome.tabs.create")) {
        shownTab = 99;

        return { result: { type: "object", value: { shownId: 11, blankId: 99 } } };
      }

      if (expression.includes("chrome.tabs.remove")) {
        shownTab = 11;

        return { result: { type: "boolean", value: true } };
      }
    }

    if (command.method === "Emulation.setDeviceMetricsOverride") {
      emulated = { width: Number(command.params.width), height: Number(command.params.height), deviceScaleFactor: Number(command.params.deviceScaleFactor) };
      before ??= view;
      view = { width: emulated.width, height: emulated.height };

      return {};
    }

    if (command.method === "Emulation.clearDeviceMetricsOverride") {
      if (before && emulated && view.width === emulated.width && view.height === emulated.height) view = before;

      before = null;
      emulated = null;

      return {};
    }

    if (command.method === "Page.getLayoutMetrics") {
      const css = emulated ?? view;

      return { cssLayoutViewport: { clientWidth: css.width, clientHeight: css.height } };
    }

    if (command.method === "Page.captureScreenshot") {
      const original = view;
      const dpfactor = emulated ? (emulated.deviceScaleFactor || ratio) / ratio : 1;
      if (emulated) view = { width: Math.floor(emulated.width * dpfactor), height: Math.floor(emulated.height * dpfactor) };
      if (shownTab === 11) return HANG;

      const pixels = emulated
        ? { width: Math.round(emulated.width * dpfactor * ratio), height: Math.round(emulated.height * dpfactor * ratio) }
        : { width: view.width * ratio, height: view.height * ratio };
      view = original;
      const answered = answerPixels(pixels);

      return { data: solidPng(answered.width, answered.height).toString("base64") };
    }

    return undefined;
  });

  session(chrome.port);

  return { view: () => view };
}

function session(port: number): void {
  vi.stubGlobal("fetch", onlyFakeChromeFetch(() => port));
  const file = readyContractPath(dir, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract("dev", "chrome", { extensionId: EXTENSION_ID, cdpPort: port, distPath: path.join(dir, "dist", "chrome") })));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-behind-"));
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

describe("extension_screenshot captures the shown tab of a window behind other windows without bringing it forward", () => {
  it("shows a blank tab in that window for the capture, switches back, and answers captured", async () => {
    await browserWithPageBehindOtherWindows();

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, path: "shots/google.png", timeout: 6_000 }));

    expect(result.status).toBe("captured");
    expect(result.value.behindWindow).toEqual({ tried: true, shown: true, restored: true, windowState: "normal" });
    expect(fs.existsSync(path.join(dir, "shots", "google.png"))).toBe(true);
    expect(result.warnings.join(" ")).toContain("never brought the window forward");

    const created = evaluated("chrome.tabs.create");
    expect(created).toHaveLength(1);
    expect(String(created[0]!.params.expression)).toContain(`windowId: ${WINDOW_ID}`);
    expect(created[0]!.sessionId).toBe("S-SW1");
    expect(String(evaluated("chrome.tabs.remove")[0]!.params.expression)).toContain("chrome.tabs.update(11, { active: true })");
    expect((chrome?.commands ?? []).map((c) => c.method)).not.toContain("Page.bringToFront");
    expect((chrome?.commands ?? []).map((c) => c.method)).not.toContain("Target.activateTarget");
  }, 20_000);

  it("captures a painted page at once and switches no tab", async () => {
    chrome = await startFakeChrome([PAGE, WORKER], (command) => (command.method === "Page.captureScreenshot" ? { data: solidPng(640, 480).toString("base64") } : undefined));
    session(chrome.port);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id }));

    expect(result.status).toBe("captured");
    expect(result.value.behindWindow).toBeUndefined();
    expect(evaluated("chrome.tabs.create")).toHaveLength(0);
  }, 20_000);

  it("432: skips a background without the tabs API and opens the blank tab from the next one", async () => {
    const other = { id: "SW2", type: "service_worker", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js" };
    let shownTab = 11;

    chrome = await startFakeChrome([PAGE, WORKER, other], (command) => {
      if (command.method === "Browser.getWindowForTarget") return { windowId: WINDOW_ID, bounds: { windowState: "normal" } };

      if (command.method === "Runtime.evaluate") {
        const expression = String(command.params.expression);

        if (expression.includes("chrome.tabs.create")) {
          if (command.sessionId === "S-SW1") return { result: { type: "object", value: { noTabs: true } } };

          shownTab = 99;

          return { result: { type: "object", value: { shownId: 11, blankId: 99 } } };
        }

        if (expression.includes("chrome.tabs.remove")) {
          shownTab = 11;

          return { result: { type: "boolean", value: true } };
        }
      }

      if (command.method === "Page.captureScreenshot") return shownTab === 11 ? HANG : { data: solidPng(640, 480).toString("base64") };

      return undefined;
    });

    session(chrome.port);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, path: "shots/google.png", timeout: 6_000 }));

    expect(result.status).toBe("captured");
    expect(result.value.behindWindow).toEqual({ tried: true, shown: true, restored: true, windowState: "normal" });
    expect(evaluated("chrome.tabs.create").map((c) => c.sessionId)).toEqual(["S-SW1", "S-SW2"]);
    expect(String(evaluated("chrome.tabs.create")[0]!.params.expression)).toContain('typeof tabs.query !== "function"');
    expect(evaluated("chrome.tabs.remove")[0]!.sessionId).toBe("S-SW2");
  }, 20_000);

  it("432: names the background that lacks the tabs API in plain words and points at extension_open foreground, never a thrown message", async () => {
    chrome = await startFakeChrome([PAGE, WORKER], (command) => {
      if (command.method === "Browser.getWindowForTarget") return { windowId: WINDOW_ID, bounds: { windowState: "normal" } };
      if (command.method === "Runtime.evaluate" && String(command.params.expression).includes("chrome.tabs.create")) return { result: { type: "object", value: { noTabs: true } } };
      if (command.method === "Page.captureScreenshot") return HANG;

      return undefined;
    });

    session(chrome.port);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, timeout: 4_000 }));

    expect(result.status).toBe("capture-timeout");
    expect(result.hint).toContain(`the extension background at chrome-extension://${EXTENSION_ID} exposes no chrome.tabs API`);
    expect(result.hint).toContain("extension_open {url, foreground: true}");
    expect(result.hint).not.toContain("TypeError");
    expect(result.hint).toContain("never brings a window forward");
  }, 30_000);

  it("says why it could not show another tab when no extension background runs, and still never brings the window forward", async () => {
    await browserWithPageBehindOtherWindows([PAGE]);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, timeout: 4_000 }));

    expect(result.status).toBe("capture-timeout");
    expect(result.hint).toContain("could not show another tab in the page's window");
    expect(result.hint).toContain("never brings a window forward");
  }, 30_000);

  it("437: spends the whole timeout on the capture when no blank tab can be shown, and names the budget and the window", async () => {
    await browserWithPageBehindOtherWindows([PAGE]);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, timeout: 4_600 }));

    expect(result.status).toBe("capture-timeout");
    expect(result.error.message).toContain("did not answer within 4600ms in all (4000ms, then 600ms");
    expect(result.error.message).not.toContain("(4000ms)");
    expect((chrome?.commands ?? []).filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(2);
    expect(result.hint).toContain("on another macOS Space");
    expect(result.hint).toContain("the browser reports its window as normal");
    expect(result.hint).toContain("spent on the capture in full");
    expect(result.hint).not.toContain("run the session headless (the default), or retry with a larger timeout.");
    expect(result.value?.behindWindow ?? result.behindWindow).toBeUndefined();
  }, 30_000);

  it("437: a timeout under the first-try bound is spent once and named as given", async () => {
    await browserWithPageBehindOtherWindows([PAGE]);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, timeout: 1_500 }));

    expect(result.status).toBe("capture-timeout");
    expect(result.error.message).toContain("(1500ms)");
    expect((chrome?.commands ?? []).filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(1);
  }, 30_000);
});

describe("495: deviceScaleFactor alone on a Retina display, when the first capture times out and the blank-tab retry paints", () => {
  it("answers a 1200x762 image for factor 1 of a 1200x762 viewport, overrides at that size each time, and gives the view its size back", async () => {
    const retina = await retinaBrowserBehindOtherWindows();

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, path: "shots/demo.png", deviceScaleFactor: 1, timeout: 6_000 }));

    expect(result.status).toBe("captured");
    expect(result.value.behindWindow).toMatchObject({ tried: true, shown: true });
    expect([result.value.width, result.value.height]).toEqual([1200, 762]);
    expect(result.warnings.join(" ")).not.toContain("was expected");

    const overrides = (chrome?.commands ?? []).filter((c) => c.method === "Emulation.setDeviceMetricsOverride").map((c) => c.params);
    expect(overrides.length).toBeGreaterThan(1);
    for (const override of overrides) expect(override).toMatchObject({ width: 1200, height: 762, deviceScaleFactor: 1 });

    const page = (chrome?.commands ?? []).filter((c) => c.sessionId === `S-${PAGE.id}`).map((c) => c.method);
    const hung = page.indexOf("Page.captureScreenshot");
    expect(page.slice(hung, hung + 3)).toEqual(["Page.captureScreenshot", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"]);
    expect(retina.view()).toEqual({ width: 1200, height: 762 });
  }, 20_000);

  it("answers 600x381 for factor 0.5 of the same viewport, the factor times the CSS size", async () => {
    await retinaBrowserBehindOtherWindows();

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, path: "shots/demo.png", deviceScaleFactor: 0.5, timeout: 6_000 }));

    expect(result.status).toBe("captured");
    expect([result.value.width, result.value.height]).toEqual([600, 381]);
    const overrides = (chrome?.commands ?? []).filter((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(overrides[overrides.length - 1]?.params).toMatchObject({ width: 1200, height: 762, deviceScaleFactor: 0.5 });
  }, 20_000);

  it("names the size the browser answered against the one asked when they differ", async () => {
    await retinaBrowserBehindOtherWindows((pixels) => ({ width: pixels.width / 2, height: Math.floor(pixels.height / 2) }));

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, path: "shots/demo.png", deviceScaleFactor: 1, timeout: 6_000 }));

    expect(result.status).toBe("captured");
    expect([result.value.width, result.value.height]).toEqual([600, 381]);
    expect(result.warnings.join(" ")).toContain("answered a 600 x 381 image where 1200 x 762 was expected (a 1200 x 762 CSS viewport at deviceScaleFactor 1)");
  }, 20_000);
});
