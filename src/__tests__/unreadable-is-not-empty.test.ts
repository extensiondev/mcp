/* @invariant a read that threw is said as unreadable, with
 * why, never reported as an empty list that sends the agent after the wrong
 * fix. Each cell here failed before its fix. */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";
import { writeEvalToken } from "./fixtures/ready-contract";

const act = vi.hoisted(() => ({
  calls: [] as string[][],
  reply: ((_cli: string[]) => JSON.stringify({ ok: true, value: {} })) as (cli: string[]) => string,
}));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);
      return act.reply(cli);
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

const cdp = vi.hoisted(() => ({
  discoverThrows: null as string | null,
  discoverThrowsFromCall: null as number | null,
  discoverCalls: 0,
  attachThrows: null as string | null,
  targets: [] as Array<{ id: string; type: string; url: string; title?: string }>,
}));
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      cdp.discoverCalls += 1;
      if (cdp.discoverThrows) throw new Error(cdp.discoverThrows);
      if (cdp.discoverThrowsFromCall !== null && cdp.discoverCalls >= cdp.discoverThrowsFromCall) {
        throw new Error("socket hang up during the poll");
      }
      return cdp.targets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    static async discoverBrowserVersion() {
      return "Chrome/151.0.7922.71";
    }
    static async discoverUserAgent() {
      return "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36";
    }
    async connect() {}
    async attachToTarget(id: string) {
      if (cdp.attachThrows) throw new Error(cdp.attachThrows);
      return `session-${id}`;
    }
    async enableDomains() {}
    async navigate() {}
    async evaluate() {
      return null;
    }
    async sendCommand(method: string) {
      if (method === "Target.openDevTools") {
        cdp.targets = [
          ...cdp.targets,
          { id: "dt", type: "page", url: "devtools://devtools/bundled/devtools_app.html?targetType=tab", title: "DevTools" },
        ];
        return { targetId: "dt" };
      }
      if (method === "Target.createTarget") {
        cdp.targets = [...cdp.targets, { id: "created", type: "page", url: "about:blank" }];
        return { targetId: "created" };
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const processManager = await import("../lib/process-manager");
const carrierRegistry = await import("../lib/carrier-registry");
const stop = await import("../tools/stop");
const bridgeTabs = await import("../lib/bridge-tabs");
const cdpDevtools = await import("../lib/cdp-devtools");
const evalTool = await import("../tools/eval");
const open = await import("../tools/open");

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
const savedSessionDir = process.env.EXTENSION_MCP_SESSION_DIR;
beforeEach(() => {
  act.calls.length = 0;
  act.reply = () => JSON.stringify({ ok: true, value: {} });
  cdp.discoverThrows = null;
  cdp.discoverThrowsFromCall = null;
  cdp.discoverCalls = 0;
  cdp.attachThrows = null;
  cdp.targets = [];
});
afterEach(() => {
  if (savedSessionDir === undefined) delete process.env.EXTENSION_MCP_SESSION_DIR;
  else process.env.EXTENSION_MCP_SESSION_DIR = savedSessionDir;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function expectedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }
  return id;
}
function chromeProject(manifest: Record<string, unknown>): { dir: string; id: string } {
  const dir = tmpDir("mcp-unreadable-");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));
  const distPath = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify(manifest));
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  writeEvalToken(dir, "chrome");
  return { dir, id: expectedId(distPath) };
}

describe("session markers and carrier records", () => {
  it("says the marker directory could not be read instead of listing nothing", () => {
    const file = path.join(tmpDir("mcp-markers-"), "sessions");
    fs.writeFileSync(file, "not a directory");
    process.env.EXTENSION_MCP_SESSION_DIR = file;
    const read = processManager.readSessionMarkers();
    expect(read.markers).toEqual([]);
    expect(read.unreadable).toMatch(/ENOTDIR|not a directory/i);
    const carriers = carrierRegistry.readRememberedCarriers();
    expect(carriers.unreadable).toMatch(/ENOTDIR|not a directory/i);
  });

  it("reads Windows' ENOENT on a path that exists as unreadable, not as no markers", () => {
    const file = path.join(tmpDir("mcp-markers-win-"), "sessions");
    fs.writeFileSync(file, "not a directory");
    process.env.EXTENSION_MCP_SESSION_DIR = file;
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === file) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${file}'`), { code: "ENOENT" });
      }
      return (realReaddir as (...a: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
    const read = processManager.readSessionMarkers();
    expect(read.markers).toEqual([]);
    expect(read.unreadable).toContain(file);
    vi.restoreAllMocks();
    fs.rmSync(file);
    expect(processManager.readSessionMarkers().unreadable).toBeNull();
  });

  it("treats an absent directory as empty, not unreadable", () => {
    process.env.EXTENSION_MCP_SESSION_DIR = path.join(tmpDir("mcp-markers-"), "never-made");
    expect(processManager.readSessionMarkers()).toEqual({ markers: [], unreadable: null });
    expect(carrierRegistry.readRememberedCarriers()).toEqual({ carriers: [], unreadable: null });
  });

  it("names a torn marker file", () => {
    const dir = tmpDir("mcp-markers-");
    process.env.EXTENSION_MCP_SESSION_DIR = dir;
    fs.writeFileSync(path.join(dir, "torn.json"), "{ half");
    const read = processManager.readSessionMarkers();
    expect(read.unreadable).toMatch(/torn\.json/);
  });

  it("extension_stop all does not call an unreadable record 'nothing to stop'", async () => {
    const file = path.join(tmpDir("mcp-markers-"), "sessions");
    fs.writeFileSync(file, "not a directory");
    process.env.EXTENSION_MCP_SESSION_DIR = file;
    const out = JSON.parse(await stop.handler({ all: true } as never));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("nothing-found-unreadable");
    expect(out.warnings.join("\n")).toMatch(/Session markers could not be fully read/);
  });
});

describe("bridge tab polls", () => {
  it("says the tab list could not be read instead of 'did not produce a tab'", async () => {
    act.reply = (cli) =>
      cli[0] === "navigate"
        ? JSON.stringify({ ok: false, error: { code: "E_CLI", message: "error: unknown command 'navigate'" } })
        : cli[0] === "eval"
          ? JSON.stringify({ ok: true, value: { tabId: 3 } })
          : envelope({ ok: false, command: "extension_open", status: "failed", error: { code: "E_NO_SESSION", message: "No active control channel found for firefox." } });
    const out = JSON.parse(await bridgeTabs.navigateToUrlViaBridge("/p", "firefox", "https://b.test/", 600));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("navigation-unconfirmed");
    expect(out.error.message).toMatch(/tab list could not be read/);
    expect(out.error.message).toMatch(/No active control channel/);
  });

  it("says so for the verb path too, keeping the verb's tab id", async () => {
    act.reply = (cli) =>
      cli[0] === "navigate"
        ? JSON.stringify({ ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "https://a.test/", created: false } })
        : envelope({ ok: false, command: "extension_open", status: "failed", error: { code: "E_NO_SESSION", message: "No active control channel found for firefox." } });
    const out = JSON.parse(await bridgeTabs.navigateToUrlViaBridge("/p", "firefox", "https://a.test/", 600));
    expect(out.status).toBe("navigation-unconfirmed");
    expect(out.error.message).toMatch(/in tab 7, but the tab list could not be read/);
  });
});

describe("devtools opener", () => {
  it("reports the stage it reached instead of blaming Target.openDevTools", async () => {
    cdp.targets = [{ id: "tab", type: "page", url: "https://a.test/" }];
    cdp.attachThrows = "Target closed";
    const outcome = await cdpDevtools.openDevToolsPanel(9222, {
      inspectedTargetId: "tab",
      extensionId: "abc",
      devtoolsPageUrl: "chrome-extension://abc/devtools/index.html",
      budgetMs: 800,
    });
    expect(outcome.opened).toBe(false);
    if (outcome.opened) return;
    expect(outcome.stage).toBe("frontend");
    expect(outcome.reason).toMatch(/Target closed.*after the frontend step/);
  });
});

describe("eval over CDP", () => {
  it("says the target list could not be read instead of the idle-worker story", async () => {
    const p = chromeProject({ manifest_version: 3, name: "F", background: { service_worker: "background.js" } });
    cdp.discoverThrows = "ECONNREFUSED 127.0.0.1:9222";
    const out = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, context: "background", expression: "1" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("targets-unreadable");
    expect(out.error.message).toMatch(/ECONNREFUSED/);
    expect(JSON.stringify(out)).not.toMatch(/idle/);
  });

  it("says so for a page named by url too", async () => {
    const p = chromeProject({ manifest_version: 3, name: "F", action: { default_popup: "action/index.html" } });
    cdp.discoverThrows = "ECONNREFUSED 127.0.0.1:9222";
    const out = JSON.parse(
      await evalTool.handler({ projectPath: p.dir, context: "page", url: `chrome-extension://${p.id}/action/index.html`, expression: "1" }),
    );
    expect(out.status).toBe("targets-unreadable");
  });
});

describe("open by url over CDP", () => {
  it("says the target list could not be read before navigating, and that nothing was navigated", async () => {
    const p = chromeProject({ manifest_version: 3, name: "F" });
    cdp.discoverThrows = "socket hang up";
    const out = JSON.parse(await open.handler({ projectPath: p.dir, url: "https://a.test/", timeout: 500 }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("targets-unreadable");
    expect(out.error.message).toMatch(/socket hang up.*Nothing was navigated/);
  });

  it("says the target list could not be read while waiting, instead of 'no live page target'", async () => {
    const p = chromeProject({ manifest_version: 3, name: "F" });
    cdp.targets = [{ id: "blank", type: "page", url: "about:blank" }];
    cdp.discoverThrowsFromCall = 2;
    const out = JSON.parse(await open.handler({ projectPath: p.dir, url: "https://a.test/", timeout: 500 }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("targets-unreadable");
    expect(out.error.message).toMatch(/while waiting for https:\/\/a\.test\//);
    expect(out.error.message).toMatch(/socket hang up during the poll/);
  }, 15_000);
});
