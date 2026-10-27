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
    expect(result.value.behindWindow).toEqual({ tried: true, shown: true, restored: true });
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

  it("says why it could not show another tab when no extension background runs, and still never brings the window forward", async () => {
    await browserWithPageBehindOtherWindows([PAGE]);

    const result = JSON.parse(await screenshot.handler({ projectPath: dir, targetId: PAGE.id, timeout: 4_000 }));

    expect(result.status).toBe("capture-timeout");
    expect(result.hint).toContain("could not show another tab in the page's window");
    expect(result.hint).toContain("never brings a window forward");
  }, 30_000);
});
