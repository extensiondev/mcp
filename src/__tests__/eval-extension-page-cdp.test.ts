import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const cliCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);
      return envelope({
        ok: true,
        command: "extension_eval",
        status: "ok",
        value: "relay",
      });
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
const evaluations: Array<{
  params: Record<string, unknown>;
  sessionId?: string;
}> = [];
let evaluateResponse: () => Record<string, unknown> = () => ({
  result: { type: "number", value: 5 },
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
    async sendCommand(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
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

const tmpDirs: string[] = [];
function project(
  manifest: Record<string, unknown>,
  browser = "chrome",
): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-cdp-"));
  tmpDirs.push(dir);
  const distPath = path.join(dir, "dist", browser);
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify({ status: "ready", distPath }),
  );
  return { dir, id: expectedId(distPath) };
}

const MV3 = {
  manifest_version: 3,
  name: "F",
  action: { default_popup: "popup.html" },
  chrome_url_overrides: { newtab: "chrome_url_overrides/newtab.html" },
};

function newtabOpen(id: string, targetId = "nt"): Target {
  return {
    id: targetId,
    type: "page",
    url: `chrome-extension://${id}/chrome_url_overrides/newtab.html`,
    title: "New Tab",
  };
}

afterEach(() => {
  cliCalls.length = 0;
  evaluations.length = 0;
  cdpTargets = [];
  cdpPort = { port: 9222 };
  evaluateResponse = () => ({ result: { type: "number", value: 5 } });
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_eval reaches an MV3 extension page over CDP, which the page CSP does not govern", () => {
  it("evaluates context newtab on the override page's own target and never shells out", async () => {
    const p = project(MV3);
    cdpTargets = [newtabOpen(p.id)];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "1 + 4",
        context: "newtab",
        browser: "chrome",
      }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("evaluated");
    expect(result.value).toBe(5);
    expect(result.hint).toContain("over CDP");
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].sessionId).toBe("session-nt");
    expect(evaluations[0].params).toMatchObject({
      expression: "1 + 4",
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
  });

  it("routes context page with a chrome-extension:// url over CDP instead of a host-permission refusal", async () => {
    const p = project(MV3);
    cdpTargets = [newtabOpen(p.id)];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "document.title",
        context: "page",
        url: `chrome-extension://${p.id}/chrome_url_overrides/newtab.html`,
        browser: "chrome",
      }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(5);
    expect(JSON.stringify(result)).not.toMatch(/permission to access this host/);
  });

  it("takes the CDP path when the context defaulted to page and the url is an extension page", async () => {
    const p = project(MV3);
    cdpTargets = [newtabOpen(p.id)];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "document.title",
        url: `chrome-extension://${p.id}/chrome_url_overrides/newtab.html`,
        browser: "chrome",
      }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("says the page is not open and how to open it, instead of a misleading error", async () => {
    const p = project(MV3);
    cdpTargets = [
      { id: "web", type: "page", url: "https://example.com/", title: "Example" },
    ];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "1",
        context: "newtab",
        browser: "chrome",
      }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_TARGET");
    expect(result.error.message).toContain(
      `chrome-extension://${p.id}/chrome_url_overrides/newtab.html`,
    );
    expect(result.hint).toContain('extension_open surface: "newtab"');
    expect(evaluations).toEqual([]);
  });

  it("reports a thrown expression as E_EVAL with the exception text", async () => {
    const p = project(MV3);
    cdpTargets = [newtabOpen(p.id)];
    evaluateResponse = () => ({
      result: { type: "object", subtype: "error", description: "ReferenceError: nope is not defined\n    at <anonymous>:1:1" },
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          type: "object",
          subtype: "error",
          description: "ReferenceError: nope is not defined\n    at <anonymous>:1:1",
        },
      },
    });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "nope",
        context: "newtab",
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_EVAL");
    expect(result.error.message).toBe("ReferenceError: nope is not defined");
  });

  it("returns null for undefined and the description for a value CDP cannot serialize", async () => {
    const p = project(MV3);
    cdpTargets = [newtabOpen(p.id)];
    evaluateResponse = () => ({ result: { type: "undefined" } });
    const undef = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "void 0",
        context: "newtab",
        browser: "chrome",
      }),
    );
    expect(undef.ok).toBe(true);
    expect(undef.value).toBeNull();

    evaluateResponse = () => ({
      result: { type: "object", subtype: "node", description: "div#root" },
    });
    const node = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "document.body.firstChild",
        context: "newtab",
        browser: "chrome",
      }),
    );
    expect(node.value).toBe("div#root");
  });

  it("names the other copies when several targets show the same page", async () => {
    const p = project(MV3);
    cdpTargets = [newtabOpen(p.id, "first"), newtabOpen(p.id, "second")];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "1",
        context: "newtab",
        browser: "chrome",
      }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations[0].sessionId).toBe("session-first");
    expect(result.warnings[0]).toContain("2 open pages match");
    expect(result.warnings[0]).toContain("second");
  });

  it("names a surface the manifest does not declare", async () => {
    const p = project({ manifest_version: 3, name: "F" });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "1",
        context: "sidebar",
        browser: "chrome",
      }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(result.error.message).toContain("side_panel.default_path");
  });

  it("says there is no session when no CDP port resolves", async () => {
    const p = project(MV3);
    cdpPort = null;

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "1",
        context: "popup",
        browser: "chrome",
      }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SESSION");
  });

  it("keeps the in-bundle relay for an MV2 Chromium surface, where eval is allowed", async () => {
    const p = project({
      manifest_version: 2,
      name: "F",
      browser_action: { default_popup: "popup.html" },
    });

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        expression: "1",
        context: "popup",
        browser: "chrome",
      }),
    );

    expect(cliCalls).toHaveLength(1);
    expect(evaluations).toEqual([]);
    expect(result.value).toBe("relay");
  });

  it("keeps the relay on Firefox, which has no CDP", async () => {
    const p = project(
      { manifest_version: 3, name: "F", sidebar_action: { default_panel: "panel.html" } },
      "firefox",
    );

    await evalTool.handler({
      projectPath: p.dir,
      expression: "1",
      context: "sidebar",
      browser: "firefox",
    });

    expect(cliCalls).toHaveLength(1);
    expect(evaluations).toEqual([]);
  });

  it("keeps the relay for a regular web page in context page", async () => {
    const p = project(MV3);

    await evalTool.handler({
      projectPath: p.dir,
      expression: "1",
      context: "page",
      url: "https://example.com/*",
      browser: "chrome",
    });

    expect(cliCalls).toHaveLength(1);
    expect(evaluations).toEqual([]);
  });
});
