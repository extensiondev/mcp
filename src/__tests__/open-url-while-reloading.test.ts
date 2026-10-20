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

import { unpackedExtensionId } from "../lib/extension-identity";
import { writeEvalToken, writeModernContract } from "./fixtures/ready-contract";

import type * as CdpPortModule from "../lib/cdp-port";

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

type Target = { id: string; type: string; url: string; title?: string };

let cdpTargets: Target[] = [];
let discoverCalls = 0;
let listExtensionAfter = Number.POSITIVE_INFINITY;
let extensionId = "";
let pageLands = false;
const createdTabs: string[] = [];

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      discoverCalls += 1;

      if (discoverCalls >= listExtensionAfter && !cdpTargets.some((t) => t.type === "service_worker")) {
        cdpTargets = [
          ...cdpTargets,
          { id: "sw", type: "service_worker", url: `chrome-extension://${extensionId}/background.js` },
        ];

        pageLands = true;
      }

      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget() {
      return "session-1";
    }
    async enableDomains() {}
    async navigate() {}
    async evaluate() {
      return null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const url = String(params?.url ?? "");
        createdTabs.push(url);
        const id = `created-${createdTabs.length}`;

        if (pageLands) cdpTargets = [...cdpTargets, { id, type: "page", url, title: "Options" }];

        return { targetId: id };
      }

      return {};
    }
    disconnect() {}
  }

  return { CDPClient };
});

const open = await import("../tools/open");
const screenshot = await import("../tools/screenshot");

const dirs: string[] = [];

function project(contract: Record<string, unknown>): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-reloading-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", options_page: "options/index.html" }),
  );

  writeModernContract(dir, "chrome", contract);
  writeEvalToken(dir, "chrome");
  const id = unpackedExtensionId(path.join(dir, "dist", "chrome"));
  extensionId = id;

  return { dir, id };
}

const now = () => new Date().toISOString();
const oldStamp = new Date(Date.now() - 10 * 60_000).toISOString();

afterEach(() => {
  cdpTargets = [];
  discoverCalls = 0;
  listExtensionAfter = Number.POSITIVE_INFINITY;
  pageLands = false;
  createdTabs.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open with an extension url while the extension reloads", () => {
  it("waits for the extension to come back, retries once and says so", async () => {
    const p = project({ runtime: "detached", executorDetachedAt: now(), compiledAt: oldStamp, ts: oldStamp });
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/" }];
    listExtensionAfter = 4;

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "chrome", url: "options/index.html", timeout: 400 }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(createdTabs).toEqual([
      `chrome-extension://${p.id}/options/index.html`,
      `chrome-extension://${p.id}/options/index.html`,
    ]);

    expect(result.value.target.targetId).toBe("created-2");
    expect(result.value.retriedAfterReload).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/reloading/);
    expect(result.warnings.join(" ")).toMatch(/retried once/);
  });

  it("answers extension-reloading, not a missing file, when the extension stays away", async () => {
    const p = project({ runtime: "detached", executorDetachedAt: now(), compiledAt: oldStamp, ts: oldStamp });
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "chrome", url: "options/index.html", timeout: 300 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("extension-reloading");
    expect(result.error.code).toBe("E_EXTENSION_RELOADING");
    expect(result.error.message).not.toMatch(/may not exist/);
    expect(result.error.message).toMatch(/reloading/);
    expect(result.hint).toMatch(/try again in a moment/i);
    expect(result.value.navigated).toBe(`chrome-extension://${p.id}/options/index.html`);
    expect(result.value.reload.kind).toBe("detached");
    expect(createdTabs).toHaveLength(1);
  });

  it("reads a reload the engine stamped moments ago as the same signal", async () => {
    const p = project({ runtime: "attached", reloadedAt: now(), reloadKind: "full", compiledAt: oldStamp, ts: oldStamp });
    cdpTargets = [{ id: "web", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "chrome", url: "options/index.html", timeout: 300 }),
    );

    expect(result.status).toBe("extension-reloading");
    expect(result.value.reload.kind).toBe("reloaded");
    expect(result.error.message).toMatch(/full reload/);
  });

  it("still answers navigate-failed when the extension is listed and nothing reloaded", async () => {
    const p = project({ runtime: "attached", executorAttachedAt: oldStamp, compiledAt: oldStamp, ts: oldStamp });
    cdpTargets = [
      { id: "web", type: "page", url: "https://example.com/" },
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/background.js` },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "chrome", url: "options/index.html", timeout: 300 }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("navigate-failed");
    expect(result.error.message).toMatch(/may not exist in the extension bundle/);
    expect(createdTabs).toHaveLength(1);
  });
});

describe("a gone extension tab after a reload", () => {
  it("target-not-found says the tab closed because the extension reloaded", async () => {
    const p = project({ runtime: "attached", executorAttachedAt: oldStamp, compiledAt: oldStamp, ts: oldStamp });
    pageLands = true;
    cdpTargets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/background.js` }];

    const opened = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "chrome", url: "options/index.html", timeout: 300 }),
    );
    expect(opened.status).toBe("navigated");
    const targetId = opened.value.target.targetId as string;

    cdpTargets = cdpTargets.filter((t) => t.id !== targetId);
    writeModernContract(p.dir, "chrome", { runtime: "attached", reloadedAt: now(), reloadKind: "full" });

    const result = JSON.parse(
      await screenshot.handler({ projectPath: p.dir, browser: "chrome", targetId }),
    );

    expect(result.status).toBe("target-not-found");
    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(result.error.message).toMatch(/options\/index\.html/);
    expect(result.error.message).toMatch(/extension reloaded/);
    expect(result.error.message).toMatch(/closes/);
    expect(result.value.extensionReloaded.kind).toBe("reloaded");
    expect(result.hint).toMatch(/extension_open/);
  });

  it("target-not-found keeps its plain wording when nothing reloaded", async () => {
    const p = project({ runtime: "attached", executorAttachedAt: oldStamp, compiledAt: oldStamp, ts: oldStamp });
    cdpTargets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/background.js` }];

    const result = JSON.parse(
      await screenshot.handler({ projectPath: p.dir, browser: "chrome", targetId: "never-opened" }),
    );

    expect(result.status).toBe("target-not-found");
    expect(result.error.message).not.toMatch(/reloaded/);
    expect(result.value.extensionReloaded).toBeUndefined();
  });
});
