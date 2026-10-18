// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { writeEvalToken } from "./fixtures/ready-contract";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

const cliCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);

      return envelope({ ok: true, command: "extension_eval", status: "ok", value: "relay" });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
const evaluations: Array<{ params: Record<string, unknown>; sessionId?: string }> = [];
const otherCommands: string[] = [];
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {
      return undefined;
    }
    async attachToTarget(targetId: string) {
      return `session-${targetId}`;
    }
    async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (method === "Runtime.evaluate") {
        evaluations.push({ params, sessionId });

        return { result: { type: "string", value: "evaluated" } };
      }

      otherCommands.push(method);

      if (method === "ServiceWorker.startWorker") {
        const scope = String(params.scopeURL ?? "");
        cdpTargets = [...cdpTargets, { id: "sw-woken", type: "service_worker", url: `${scope}background.js`, title: "" }];
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-bg-picker-"));
  dirs.push(dir);
  const distPath = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  writeEvalToken(dir, "chrome");

  return { dir, id: expectedId(distPath) };
}

const MV3 = { manifest_version: 3, name: "F", background: { service_worker: "background.js" } };
const MV2 = { manifest_version: 2, name: "F", background: { scripts: ["bg.js"] } };

const offscreen = (id: string): Target => ({
  id: "offscreen",
  type: "background_page",
  url: `chrome-extension://${id}/pages/ocr.html`,
  title: "",
});
const worker = (id: string): Target => ({
  id: "sw",
  type: "service_worker",
  url: `chrome-extension://${id}/background.js`,
  title: "",
});

afterEach(() => {
  cliCalls.length = 0;
  evaluations.length = 0;
  otherCommands.length = 0;
  cdpTargets = [];
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval context background picks the background the manifest declares", () => {
  it("takes the MV3 service worker over an open offscreen document and says the document is open", async () => {
    const p = project(MV3);
    cdpTargets = [offscreen(p.id), worker(p.id)];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "background", expression: "1" }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].sessionId).toBe("session-sw");
    expect(result.hint).toContain("service_worker");
    expect(String(result.warnings)).toContain("offscreen");
    expect(String(result.warnings)).toContain(`chrome-extension://${p.id}/pages/ocr.html`);
    expect(String(result.warnings)).toContain('context: "page"');
    expect(String(result.warnings)).not.toContain("background targets match");
    expect(cliCalls).toEqual([]);
  });

  it("wakes the MV3 service worker when only the offscreen document is listed", async () => {
    const p = project(MV3);
    cdpTargets = [offscreen(p.id), { id: "tab", type: "page", url: "https://example.com/", title: "Example" }];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "background", expression: "1" }),
    );

    expect(result.ok).toBe(true);
    expect(otherCommands).toContain("ServiceWorker.startWorker");
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].sessionId).toBe("session-sw-woken");
    expect(String(result.warnings)).toContain("offscreen");
  });

  it("keeps the MV2 background page when it is the only background target", async () => {
    const p = project(MV2);
    cdpTargets = [
      { id: "bgp", type: "background_page", url: `chrome-extension://${p.id}/_generated_background_page.html`, title: "" },
    ];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "background", expression: "1" }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations[0].sessionId).toBe("session-bgp");
    expect(otherCommands).not.toContain("ServiceWorker.startWorker");
    expect(result.warnings.filter(Boolean)).toEqual([]);
  });
});

describe("extension_eval context page on Chromium keeps the url fragment when picking the page", () => {
  const pdfTab = (id: string, name: string): Target => ({
    id: name,
    type: "page",
    url: `chrome-extension://${id}/pages/pdf.html#http://127.0.0.1:8765/media/${name}.pdf`,
    title: name,
  });

  it("evaluates in the page whose fragment matches", async () => {
    const p = project(MV3);
    cdpTargets = [pdfTab(p.id, "scan"), pdfTab(p.id, "letter")];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        browser: "chrome",
        context: "page",
        url: `chrome-extension://${p.id}/pages/pdf.html#http://127.0.0.1:8765/media/letter.pdf`,
        expression: "1",
      }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].sessionId).toBe("session-letter");
  });

  it("refuses with both urls when the url matches pages that differ only in the fragment", async () => {
    const p = project(MV3);
    cdpTargets = [pdfTab(p.id, "scan"), pdfTab(p.id, "letter")];

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: p.dir,
        browser: "chrome",
        context: "page",
        url: `chrome-extension://${p.id}/pages/pdf.html`,
        expression: "1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_AMBIGUOUS_TARGET");
    expect(result.error.message).toContain("scan.pdf");
    expect(result.error.message).toContain("letter.pdf");
    expect(evaluations).toHaveLength(0);
  });
});
