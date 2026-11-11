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

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { readyContractPath } from "../lib/session-paths";
import { actFailure, actVerbAnswer, attachedDevContract } from "./fixtures/engine-answers";
import { fakeFirefoxSidebar, SIDEBAR_ADDON_ID, SIDEBAR_URL, type FakeFirefoxSidebar } from "./fixtures/fake-firefox-sidebar";

import type * as ActModule from "../lib/act";

const gestureRefusal = () =>
  actVerbAnswer(
    actFailure("open", { name: "Unsupported", message: "sidePanel not available (engine: firefox)", engine: "firefox", code: "E_NOT_IMPLEMENTED" }),
    "extension_open",
  );
const panelClosed = () =>
  actVerbAnswer(
    actFailure("open", { code: "E_TARGET_NOT_FOUND", name: "Unsupported", message: "surface 'sidebar' is not open", engine: "firefox" }, "not-found"),
    "extension_open",
  );
const replayedWithoutGesture = () =>
  envelope({ ok: true, command: "extension_open", status: "ok", value: { triggered: "onClicked", listeners: 1, gesture: false } });

const calls: string[][] = [];
let engineOpen: () => string = gestureRefusal;
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      if (cli[0] === "inspect") return panelClosed();

      return engineOpen();
    },
  };
});

const open = await import("../tools/open");
const screenshot = await import("../tools/screenshot");

const dirs: string[] = [];
const fakes: FakeFirefoxSidebar[] = [];

const MV2 = {
  manifest_version: 2,
  name: "Sidebar",
  browser_specific_settings: { gecko: { id: SIDEBAR_ADDON_ID } },
  sidebar_action: { default_panel: "sidebar/index.html" },
  browser_action: { default_title: "Toggle the sidebar" },
  background: { scripts: ["background.js"] },
};

function project(manifest: Record<string, unknown>, rdpPort?: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gecko-sidebar-controller-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));

  if (rdpPort !== undefined) {
    const ready = readyContractPath(dir, "firefox");
    fs.mkdirSync(path.dirname(ready), { recursive: true });
    fs.writeFileSync(ready, JSON.stringify(attachedDevContract("firefox", { cdpPort: undefined, rdpPort, pid: process.pid, distPath: dist })));
  }

  return dir;
}

async function firefox(options: Parameters<typeof fakeFirefoxSidebar>[0] = {}): Promise<FakeFirefoxSidebar> {
  const fake = await fakeFirefoxSidebar(options);
  fakes.push(fake);

  return fake;
}

afterEach(async () => {
  calls.length = 0;
  engineOpen = gestureRefusal;
  open.renderedGeckoSurfaces.clear();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

describe("extension_open surface sidebar on Firefox opens the real panel through the browser's sidebar controller", () => {
  it("opens the panel the engine cannot open, and answers its document and size", async () => {
    const fake = await firefox();
    const dir = project(MV2, fake.port);

    const result = JSON.parse(await open.handler({ projectPath: dir, browser: "firefox", surface: "sidebar", timeout: 15000 }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("opened");
    expect(result.value).toMatchObject({ surface: "sidebar", via: "browser-sidebar-controller", url: SIDEBAR_URL, panel: { width: 360, height: 700 } });
    expect(fake.opens).toBe(1);
    expect(fake.sidebarOpen()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("rendered as a tab");
  }, 20_000);
});

describe("extension_screenshot context sidebar on Firefox captures the open panel", () => {
  it("captures the panel's own browsing context, not a tab", async () => {
    const fake = await firefox({ open: true });
    const dir = project(MV2, fake.port);

    const out = JSON.parse(await screenshot.handler({ projectPath: dir, browser: "firefox", context: "sidebar", timeout: 15000 }));

    expect(out.ok).toBe(true);
    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0]).toMatchObject({ browsingContextID: 77 });
    expect(out.warnings.join("\n")).toMatch(/real sidebar panel at the panel's own 360x700 CSS px/);
  }, 20_000);

  it("518: opens the closed panel through the browser's sidebar controller, the way extension_open does, then captures it and says opened: true", async () => {
    const fake = await firefox();
    const dir = project(MV2, fake.port);

    const out = JSON.parse(await screenshot.handler({ projectPath: dir, browser: "firefox", context: "sidebar", timeout: 15000 }));

    expect(out.ok).toBe(true);
    expect(out.value).toMatchObject({ context: "sidebar", url: SIDEBAR_URL, transport: "rdp", opened: true });
    expect(calls.map((cli) => cli[0])).toEqual(["open", "inspect"]);
    expect(fake.opens).toBe(1);
    expect(fake.sidebarOpen()).toBe(true);
    expect(fake.captures).toHaveLength(1);
    expect(out.warnings.join("\n")).toMatch(/opened the real panel through the browser's own sidebar controller/);
    expect(out.warnings.join("\n")).toContain('The sidebar was closed, so this call opened it the way extension_open surface: "sidebar" does, then read it');
  }, 20_000);
});

describe("extension_open surface action on Firefox and the user gesture its listener may need", () => {
  it("clicks the toolbar button with user input when the build declares a sidebar_action, instead of the gesture-less replay", async () => {
    const fake = await firefox({ clickTogglesSidebar: true });
    const dir = project(MV2, fake.port);
    engineOpen = replayedWithoutGesture;

    const result = JSON.parse(await open.handler({ projectPath: dir, browser: "firefox", surface: "action", timeout: 15000 }));

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ triggered: "onClicked", via: "browser-toolbar-action", gesture: "user-input" });
    expect(fake.clicks).toEqual([{ userInput: true }]);
    expect(fake.sidebarOpen()).toBe(true);
    expect(calls.filter((cli) => cli[0] === "open")).toHaveLength(0);
  }, 20_000);

  it("warns that the replay carried no user input and names the route that works when the click cannot run", async () => {
    const dir = project(MV2);
    engineOpen = replayedWithoutGesture;

    const result = JSON.parse(await open.handler({ projectPath: dir, browser: "firefox", surface: "action", timeout: 15000 }));
    const warnings = result.warnings.join("\n");

    expect(result.ok).toBe(true);
    expect(result.value.gesture).toBe(false);
    expect(warnings).toContain("without user input");
    expect(warnings).toContain("sidebarAction.toggle");
    expect(warnings).toContain('extension_open surface: "sidebar"');
    expect(warnings).toContain("did not run");
  }, 20_000);

  it("answers the engine's rdpPortError and the next step at once when Firefox opened no debug port", async () => {
    const dir = project(MV2);
    const ready = readyContractPath(dir, "firefox");
    fs.mkdirSync(path.dirname(ready), { recursive: true });
    fs.writeFileSync(ready, JSON.stringify(attachedDevContract("firefox", { cdpPort: undefined, pid: process.pid, rdpPortError: "Firefox did not open its remote debugging port 6000 within 30000ms" })));
    engineOpen = replayedWithoutGesture;

    const started = Date.now();
    const result = JSON.parse(await open.handler({ projectPath: dir, browser: "firefox", surface: "action", timeout: 15000 }));
    const warnings = result.warnings.join("\n");

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(warnings).toContain("the engine says Firefox did not open its remote debugging port 6000 within 30000ms");
    expect(warnings).toContain("extension_logs shows the launcher's last lines, and extension_dev with replace: true starts a new session");
    expect(warnings).not.toContain("records no debugger (RDP) port");
  }, 20_000);

  it("still names the missing gesture on a build without a sidebar_action, and leaves the engine's replay in place", async () => {
    const fake = await firefox();
    const { sidebar_action: _drop, ...plain } = MV2;
    const dir = project(plain, fake.port);
    engineOpen = replayedWithoutGesture;

    const result = JSON.parse(await open.handler({ projectPath: dir, browser: "firefox", surface: "action", timeout: 15000 }));
    const warnings = result.warnings.join("\n");

    expect(fake.clicks).toHaveLength(0);
    expect(warnings).toContain("without user input");
    expect(warnings).not.toContain('extension_open surface: "sidebar"');
  }, 20_000);
});
