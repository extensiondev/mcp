import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const gestureRefusal = () =>
  JSON.stringify({
    schema: 1,
    ok: false,
    command: "extension_open",
    status: "failed",
    value: null,
    error: {
      name: "Unsupported",
      message:
        "sidePanel.open: `sidePanel.open()` may only be called in response to a user gesture.",
      engine: "chromium",
      code: "E_USER_GESTURE_REQUIRED",
    },
    warnings: [],
  });

let actResult = gestureRefusal();
const cliCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);
      return actResult;
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222 }) };
});

type Target = { id: string; type: string; url: string; title?: string };
let cdpTargets: Target[] = [];
let panelRejects: string | null = null;
let hostStaysListedAfterClose = false;
const commands: Array<{
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}> = [];
let armed = false;
let phase: string | null = null;
let phaseMessage: string | undefined;
let hostUrl = "";

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(targetId: string) {
      return `session-${targetId}`;
    }
    async navigate(_session: string, url: string) {
      cdpTargets = [
        ...cdpTargets,
        { id: "navigated", type: "page", url, title: "Landed" },
      ];
    }
    async evaluate() {
      return null;
    }
    async sendCommand(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
      commands.push({ method, params, sessionId });
      if (method === "Target.createTarget") {
        const url = String(params.url ?? "");
        const id = params.background === true ? "fallback-tab" : "host";
        if (id === "host") hostUrl = url;
        cdpTargets = [...cdpTargets, { id, type: "page", url }];
        return { targetId: id };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression ?? "");
        if (expression.includes("chrome.sidePanel.open")) {
          armed = true;
          phase = "armed";
          return { result: { type: "number", value: 7 } };
        }
        if (expression.includes("typeof chrome.sidePanel")) {
          return { result: { type: "boolean", value: true } };
        }
        if (expression.includes("__extensionDevSidePanel")) {
          return {
            result: {
              type: "object",
              value: armed ? { phase, message: phaseMessage } : null,
            },
          };
        }
        return { result: { type: "undefined" } };
      }
      if (method === "Input.dispatchMouseEvent") {
        if (params.type === "mouseReleased" && armed) {
          if (panelRejects) {
            phase = "failed";
            phaseMessage = panelRejects;
          } else {
            phase = "opened";
            cdpTargets = [
              ...cdpTargets,
              { id: "panel", type: "page", url: hostUrl, title: "Panel" },
            ];
          }
        }
        return {};
      }
      if (method === "Target.closeTarget") {
        if (!hostStaysListedAfterClose) {
          cdpTargets = cdpTargets.filter((t) => t.id !== params.targetId);
        }
        return {};
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const open = await import("../tools/open");

function expectedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }
  return id;
}

const tmpDirs: string[] = [];
function project(): { dir: string; id: string; url: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-gesture-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "F",
      permissions: ["sidePanel"],
      side_panel: { default_path: "sidebar/index.html" },
    }),
  );
  const distPath = path.join(dir, "dist", "chrome");
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify({ status: "ready", distPath }),
  );
  const id = expectedId(distPath);
  return { dir, id, url: `chrome-extension://${id}/sidebar/index.html` };
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["EXTENSION_HEADLESS", "EXTENSION_BROWSER_FLAGS"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ["EXTENSION_HEADLESS", "EXTENSION_BROWSER_FLAGS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  actResult = gestureRefusal();
  cliCalls.length = 0;
  commands.length = 0;
  cdpTargets = [];
  panelRejects = null;
  hostStaysListedAfterClose = false;
  armed = false;
  phase = null;
  phaseMessage = undefined;
  hostUrl = "";
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const clicks = () =>
  commands.filter((c) => c.method === "Input.dispatchMouseEvent");

describe("extension_open sidebar on Chromium when Chrome demands a user gesture", () => {
  it("opens the real panel through a synthetic click on the extension's own page and says what it did", async () => {
    const p = project();

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "sidebar" }),
    );

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].slice(0, 2)).toEqual(["open", "sidebar"]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("opened");
    expect(result.value).toEqual({
      surface: "sidebar",
      gesture: "synthetic-click",
      surfaceTarget: { targetId: "panel", url: p.url },
    });
    expect(result.warnings[0]).toContain("synthetic");
    expect(result.warnings[0]).toContain("toolbar wiring");
    expect(result.warnings[0]).toContain("not exercised");
    expect(result.hint).toContain("context: 'sidebar'");
  });

  it("hosts the gesture in a tab at the sidebar document, clicks it over CDP, then closes that tab", async () => {
    const p = project();

    await open.handler({ projectPath: p.dir, surface: "sidebar" });

    const created = commands.find((c) => c.method === "Target.createTarget");
    expect(created?.params.url).toBe(p.url);
    expect(created?.params.background).toBeUndefined();
    const pressed = clicks().map((c) => c.params.type);
    expect(pressed).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    for (const click of clicks()) expect(click.sessionId).toBe("session-host");
    const armedAt = commands.findIndex(
      (c) =>
        c.method === "Runtime.evaluate" &&
        String(c.params.expression).includes("chrome.sidePanel.open"),
    );
    const clickedAt = commands.findIndex(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(armedAt).toBeGreaterThan(-1);
    expect(armedAt).toBeLessThan(clickedAt);
    const closed = commands.find((c) => c.method === "Target.closeTarget");
    expect(closed?.params.targetId).toBe("host");
    expect(cdpTargets.find((t) => t.id === "host")).toBeUndefined();
  });

  it("never mistakes the host tab for the panel when the browser still lists it after close", async () => {
    const p = project();
    hostStaysListedAfterClose = true;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "sidebar" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.surfaceTarget.targetId).toBe("panel");
  });

  it("renders the sidebar document as a tab and names the reason when the panel refuses even the synthetic click", async () => {
    const p = project();
    panelRejects = "No active side panel for windowId: 7";

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "sidebar" }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(result.value.renderedAsTab).toMatchObject({
      surface: "sidebar",
      extensionId: p.id,
    });
    const warning = result.warnings.find((w: string) =>
      w.includes("synthetic click did not open it"),
    );
    expect(warning).toContain("No active side panel for windowId: 7");
    expect(warning).toContain("toolbar wiring stay unverified");
    expect(commands.find((c) => c.method === "Target.closeTarget")?.params.targetId).toBe(
      "host",
    );
  }, 15_000);

  it("leaves a headless session on its tab fallback without dispatching any click", async () => {
    const p = project();
    process.env.EXTENSION_HEADLESS = "1";

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "sidebar" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.renderedAsTab.surface).toBe("sidebar");
    expect(clicks()).toEqual([]);
    expect(result.warnings.join("\n")).toContain("headless");
  });

  it("passes any other engine failure through untouched", async () => {
    const p = project();
    actResult = envelope({
      ok: false,
      command: "extension_open",
      status: "no-session",
      error: { code: "E_NO_SESSION", name: "NoSession", message: "no session" },
    });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "sidebar" }),
    );

    expect(result.error.name).toBe("NoSession");
    expect(clicks()).toEqual([]);
    expect(commands.find((c) => c.method === "Target.createTarget")).toBeUndefined();
  });

  it("does not attempt the gesture on a Gecko session, where the refusal cannot occur and CDP is absent", async () => {
    const p = project();

    const result = JSON.parse(
      await open.handler({
        projectPath: p.dir,
        surface: "sidebar",
        browser: "firefox",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_USER_GESTURE_REQUIRED");
    expect(clicks()).toEqual([]);
  });
});
