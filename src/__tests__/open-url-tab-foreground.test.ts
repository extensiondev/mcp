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

import { envelope } from "../lib/envelope";
import { readyContractPath } from "../lib/session-paths";
import { actFrame, readyContract, tabRows } from "./fixtures/engine-answers";
import { onlyFakeChromeFetch, startFakeChrome, type FakeChrome, type FakeCommand } from "./fixtures/fake-chrome";

import type * as ActModule from "../lib/act";

const SITE = "https://rebeccat.example/";
let tabActive = false;

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      if (cli.includes("--list-tabs")) return JSON.stringify(actFrame("inspect", tabRows([{ id: 7, url: SITE, title: "Rebeccat", active: tabActive }])));

      return envelope({ ok: true, command: "extension_open", status: "ok", value: { tabId: 7, created: false } });
    },
  };
});

const open = await import("../tools/open");

const EXTENSION_ID = "gilebldjbffpkjnbciipghplepdmpjde";
const PAGE = { id: "PAGE7", type: "page", url: SITE };
const WORKER = { id: "SW1", type: "service_worker", url: `chrome-extension://${EXTENSION_ID}/background/service_worker.js` };

let dir: string;
let chrome: FakeChrome | null;

function evaluated(fragment: string): FakeCommand[] {
  return (chrome?.commands ?? []).filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes(fragment));
}

async function browser(targets = [PAGE, WORKER], windowRefused = false): Promise<void> {
  chrome = await startFakeChrome(targets, (command) => {
    if (command.method === "Runtime.evaluate" && String(command.params.expression).includes("chrome.tabs.update(7, { active: true })")) {
      tabActive = true;

      return { result: { type: "object", value: { active: true, windowRaised: !windowRefused, refused: windowRefused ? "No window with id: 3." : null } } };
    }

    return undefined;
  });

  vi.stubGlobal("fetch", onlyFakeChromeFetch(() => chrome!.port));
  const file = readyContractPath(dir, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract("dev", "chrome", { extensionId: EXTENSION_ID, cdpPort: chrome.port, distPath: path.join(dir, "dist", "chrome") })));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-tab-foreground-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "R" }));
  chrome = null;
  tabActive = false;
  vi.stubEnv("EXTENSION_HEADLESS", "0");
  vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
  vi.stubGlobal("fetch", () => {
    throw new Error("these specs reach only their fake browser");
  });
});

afterEach(async () => {
  await chrome?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("extension_open {url, tab, foreground: true} brings the tab it navigated in place forward", () => {
  it("activates that chrome.tabs id from the extension background, raises its window, and says so", async () => {
    await browser();

    const result = JSON.parse(await open.handler({ projectPath: dir, url: SITE, tab: 7, foreground: true }));

    expect(result.ok).toBe(true);
    expect(result.value.foreground).toEqual({ requested: true, activated: true, windowRaised: true });
    expect(result.value.tab).toMatchObject({ tabId: 7, active: true });
    expect(result.hint).toContain("brought forward as asked");
    expect(result.hint).not.toContain("The tab is hidden");
    expect(String(result.warnings ?? [])).not.toContain("switch to it");

    const ran = evaluated("chrome.tabs.update(7, { active: true })");
    expect(ran).toHaveLength(1);
    expect(ran[0]!.sessionId).toBe("S-SW1");
    expect(String(ran[0]!.params.expression)).toContain("chrome.windows.update(tab.windowId, { focused: true })");
  }, 20_000);

  it("says the tab is active but the window was not raised when chrome.windows.update refuses", async () => {
    await browser([PAGE, WORKER], true);

    const result = JSON.parse(await open.handler({ projectPath: dir, url: SITE, tab: 7, foreground: true }));

    expect(result.value.foreground).toEqual({ requested: true, activated: true, windowRaised: false, reason: "chrome.windows.update refused: No window with id: 3." });
    expect(result.hint).toContain("the window was not raised");
  }, 20_000);

  it("names why when no extension background runs to switch tabs, and asks the person only then", async () => {
    await browser([PAGE]);

    const result = JSON.parse(await open.handler({ projectPath: dir, url: SITE, tab: 7, foreground: true }));

    expect(result.ok).toBe(true);
    expect(result.value.foreground).toMatchObject({ activated: false, windowRaised: false });
    expect(result.value.foreground.reason).toContain("no extension background is running");
    expect(result.warnings.join(" ")).toContain("NOT brought forward");
  }, 20_000);

  it("switches nothing without foreground", async () => {
    await browser();

    const result = JSON.parse(await open.handler({ projectPath: dir, url: SITE, tab: 7 }));

    expect(result.ok).toBe(true);
    expect(result.value).not.toHaveProperty("foreground");
    expect(evaluated("chrome.tabs.update")).toHaveLength(0);
  }, 20_000);
});
