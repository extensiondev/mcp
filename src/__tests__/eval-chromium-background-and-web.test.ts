import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const cliCalls: string[][] = [];
let relayReply: () => string = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: "relay" });
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);
      return relayReply();
    },
  };
});

let cdpPort: { port: number } | null = { port: 9222 };
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => cdpPort };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
const evaluations: Array<{ params: Record<string, unknown>; sessionId?: string }> = [];
let evaluateResponse: () => Record<string, unknown> = () => ({
  result: { type: "number", value: 7 },
});
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
    async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (method === "Runtime.evaluate") {
        evaluations.push({ params, sessionId });
        return evaluateResponse();
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const evalTool = await import("../tools/eval");

function expectedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }
  return id;
}

const dirs: string[] = [];
function project(manifest: Record<string, unknown>): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-bg-web-"));
  dirs.push(dir);
  const distPath = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  return { dir, id: expectedId(distPath) };
}

const MV3 = {
  manifest_version: 3,
  name: "F",
  background: { service_worker: "background.js" },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};

afterEach(() => {
  cliCalls.length = 0;
  evaluations.length = 0;
  cdpTargets = [];
  cdpPort = { port: 9222 };
  relayReply = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: "relay" });
  evaluateResponse = () => ({ result: { type: "number", value: 7 } });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval reaches the Chromium background over CDP, where the extension's CSP does not apply", () => {
  it("evaluates on the service worker target and never asks the relay", async () => {
    const p = project(MV3);
    cdpTargets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/background.js`, title: "" },
      { id: "web", type: "page", url: "https://example.com/", title: "Example" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        browser: "chrome",
        context: "background",
        expression: "chrome.runtime.id",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe(7);
    expect(cliCalls).toEqual([]);
    expect(evaluations[0].sessionId).toBe("session-sw");
    expect(result.hint).toContain("service_worker");
    expect(result.hint).toContain("CSP does not govern");
  });

  it("uses the MV2 background page target too", async () => {
    const p = project({ manifest_version: 2, name: "F", background: { scripts: ["bg.js"] } });
    cdpTargets = [
      { id: "bgp", type: "background_page", url: `chrome-extension://${p.id}/_generated_background_page.html`, title: "" },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "background", expression: "1" }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations[0].sessionId).toBe("session-bgp");
    expect(cliCalls).toEqual([]);
  });

  it("says the worker is idle and how to wake it when no background target is listed", async () => {
    const p = project(MV3);
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "background", expression: "1" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_TARGET");
    expect(result.error.message).toContain("idle MV3 service worker");
    expect(result.hint).toContain("extension_reload");
    expect(evaluations).toEqual([]);
  });

  it("keeps the relay for the background when no debug port resolves", async () => {
    const p = project(MV3);
    cdpPort = null;

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "background", expression: "1" }),
    );

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0][cliCalls[0].indexOf("--context") + 1]).toBe("background");
    expect(result.value).toBe("relay");
  });
});

describe("extension_eval evaluates a web tab named by url over CDP, so Trusted Types never see the string", () => {
  it("matches the tab by url and evaluates on its target", async () => {
    const p = project(MV3);
    cdpTargets = [
      { id: "yt", type: "page", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Never" },
      { id: "other", type: "page", url: "https://example.com/", title: "Example" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        browser: "chrome",
        context: "page",
        url: "youtube.com/watch",
        expression: "document.querySelectorAll('.playerButton').length",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe(7);
    expect(evaluations[0].sessionId).toBe("session-yt");
    expect(cliCalls).toEqual([]);
    expect(result.hint).toContain("Trusted Types");
  });

  it("refuses a tab that shows the browser's error page", async () => {
    const p = project(MV3);
    cdpTargets = [
      { id: "err", type: "page", url: "chrome-error://chromewebdata/", title: "This page has been blocked by Microsoft Edge" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        browser: "edge",
        context: "page",
        url: "chrome-error",
        expression: "1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_TARGET");
    expect(result.error.message).toContain("blocked by Microsoft Edge");
    expect(evaluations).toEqual([]);
  });

  it("hands a url no tab matches back to the relay, which knows match patterns", async () => {
    const p = project(MV3);
    cdpTargets = [{ id: "other", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        browser: "chrome",
        context: "page",
        url: "https://news.example/*",
        expression: "1",
      }),
    );

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toContain("--url");
    expect(evaluations).toEqual([]);
    expect(result.value).toBe("relay");
  });

  it("names Trusted Types and the url route when the relay is refused on the active tab", async () => {
    const p = project(MV3);
    relayReply = () =>
      envelope({
        ok: false,
        command: "extension_eval",
        status: "failed",
        error: {
          code: "E_EVAL",
          name: "EvalError",
          message:
            "Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements.",
        },
      });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "page", expression: "1" }),
    );

    expect(result.ok).toBe(false);
    expect(result.hint).toContain("Trusted Types");
    expect(result.hint).toContain("Pass url");
    expect(evaluations).toEqual([]);
  });
});
