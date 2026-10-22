import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { readyContract } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async () => JSON.stringify({ ok: false, error: { message: "not used" } }),
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> = [];
let evaluated: string[] = [];
let viewAnswer: () => unknown = () => null;
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(id: string) {
      return `session-${id}`;
    }
    async enableDomains() {}
    async navigate(sessionId: string, url: string) {
      const id = sessionId.replace(/^session-/, "");
      cdpTargets = cdpTargets.map((t) => (t.id === id ? { ...t, url } : t));
    }
    async evaluate(_sessionId: string, expression: string) {
      evaluated.push(expression);

      return viewAnswer();
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        cdpTargets = [...cdpTargets, { id: "created", type: "page", url: String(params?.url ?? "") }];

        return { targetId: "created" };
      }

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const open = await import("../tools/open");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-tab-view-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", action: { default_popup: "popup.html" } }),
  );

  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify(readyContract("dev", "chrome", { distPath: path.join(dir, "dist", "chrome") })),
  );

  return dir;
}

afterEach(() => {
  cdpTargets = [];
  evaluated = [];
  viewAnswer = () => null;
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open with a url says whether the tab is shown, how big the viewport is and whether the session is headless", () => {
  it("answers tab, viewport and headless for a background tab in a headless session, and says what is not observed", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "1");
    cdpTargets = [{ id: "panel", type: "page", url: "chrome-extension://abc/pages/devpanel.html" }];
    viewAnswer = () => ({ visibilityState: "hidden", width: 1280, height: 769 });

    const result = JSON.parse(await open.handler({ projectPath: project(), url: "https://example.com/" }));

    expect(result.ok).toBe(true);
    expect(result.value.target.targetId).toBe("created");
    expect(result.value.tab).toEqual({ active: false, visibilityState: "hidden" });
    expect(result.value.viewport).toEqual({ width: 1280, height: 769 });
    expect(result.value.headless).toBe(true);
    expect(evaluated.some((e) => e.includes("document.visibilityState") && e.includes("innerHeight"))).toBe(true);
    expect(result.hint).toContain("The tab is hidden (hidden)");
    expect(result.hint).toContain("The viewport is 1280x769");
    expect(result.hint).toContain("not observed (IntersectionObserver, lazy loading) until it is scrolled into view");
  });

  it("answers an active tab in a headed session as shown, and headless false", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "0");
    vi.stubEnv("EXTENSION_BROWSER_FLAGS", "");
    cdpTargets = [{ id: "reused", type: "page", url: "about:blank" }];
    viewAnswer = () => ({ visibilityState: "visible", width: 1440, height: 900 });

    const result = JSON.parse(await open.handler({ projectPath: project(), url: "https://example.com/" }));

    expect(result.ok).toBe(true);
    expect(result.value.tab).toEqual({ active: true, visibilityState: "visible" });
    expect(result.value.viewport).toEqual({ width: 1440, height: 900 });
    expect(result.value.headless).toBe(false);
    expect(result.hint).toContain("The tab is the one its window shows.");
    expect(result.hint).not.toContain("The tab is hidden");
  });

  it("omits tab and viewport rather than guess when the page cannot be read, and still answers the navigation", async () => {
    vi.stubEnv("EXTENSION_HEADLESS", "1");
    cdpTargets = [{ id: "reused", type: "page", url: "about:blank" }];

    viewAnswer = () => {
      throw new Error("the page threw while evaluating: detached");
    };

    const result = JSON.parse(await open.handler({ projectPath: project(), url: "https://example.com/" }));

    expect(result.ok).toBe(true);
    expect(result.value.target.targetId).toBe("reused");
    expect(result.value).not.toHaveProperty("tab");
    expect(result.value).not.toHaveProperty("viewport");
    expect(result.value.headless).toBe(true);
    expect(result.hint).not.toContain("viewport is");
  });

  it("names the fields and the scroll rule in the tool description", () => {
    expect(open.schema.description).toContain("tab {active, visibilityState}");
    expect(open.schema.description).toContain("viewport {width, height}");
    expect(open.schema.description).toContain("not observed until it is scrolled into view");
  });
});
