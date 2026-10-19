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

import { afterEach, describe, expect, it, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { solidPng } from "./fixtures/png";
import { writeEvalToken } from "./fixtures/ready-contract";

import type * as ActModule from "../lib/act";
import type * as CaptureModule from "../lib/capture";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";
import type { RdpTab } from "../lib/rdp";

const engineCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[], _projectPath: string, _timeout: unknown, command: string) => {
      engineCalls.push(cli);

      return envelope({ ok: true, command, status: "ok", value: { via: "engine" } });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }),
    resolveRdpPort: async () => ({ port: 6000, source: "contract" as const }),
  };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
const attached: string[] = [];
const navigations: string[] = [];
const evaluations: Array<{ sessionId?: string; expression: unknown }> = [];

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    connect = async () => undefined;
    async attachToTarget(targetId: string) {
      attached.push(targetId);

      return `session-${targetId}`;
    }
    enableDomains = async () => undefined;
    async navigate(_sessionId: string, url: string) {
      navigations.push(url);
    }
    async evaluate() {
      return "";
    }
    async getPageMeta(sessionId: string) {
      return { session: sessionId };
    }
    getConsoleSummary() {
      return {};
    }
    resetConsole() {}
    async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (method === "Runtime.evaluate") {
        evaluations.push({ sessionId, expression: params.expression });

        return { result: { type: "object", value: { read: sessionId } } };
      }

      if (method === "Page.captureScreenshot") return { data: solidPng(4, 3).toString("base64") };

      return {};
    }
    disconnect() {}
  }

  return { CDPClient, normalizeDomSnapshot: () => ({ nodes: [], truncated: false }) };
});

let openTabs: RdpTab[] = [];
const rdpPicked: Array<RdpTab | null | undefined> = [];
vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => openTabs,
    rdpEvaluateInTab: async (_port: number, options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined }) => {
      const tab = options.select(openTabs);
      rdpPicked.push(tab);
      if (!tab) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };

      return { ok: true, value: { meta: { url: tab.url, title: tab.title } }, tab: { url: String(tab.url), title: String(tab.title ?? "") } };
    },
  };
});

const rdpCaptures: number[] = [];
vi.mock("../lib/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof CaptureModule>();

  return {
    ...actual,
    captureRdpTab: async (_port: number, contextId: number) => {
      rdpCaptures.push(contextId);

      return { ok: true as const, png: solidPng(4, 3) };
    },
  };
});

const screenshot = await import("../tools/screenshot");
const domSnapshot = await import("../tools/dom-snapshot");
const inspect = await import("../tools/inspect");
const evalTool = await import("../tools/eval");
const open = await import("../tools/open");

const dirs: string[] = [];

function project(browser: string, token = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-target-id-"));
  dirs.push(dir);
  const distPath = path.join(dir, "dist", browser);
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Pick", version: "1.0.0" }));
  const readyDir = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  if (token) writeEvalToken(dir, browser);

  return dir;
}

const PAGE = "http://127.0.0.1:8765/index.html";
const page = (id: string, url = PAGE): Target => ({ id, type: "page", url, title: id });
const tab = (browserId: number, url = PAGE, extra: Partial<RdpTab> = {}): RdpTab => ({
  actor: `server1.conn9.tabDescriptor${browserId}`,
  browserId,
  browsingContextID: browserId * 10,
  url,
  title: `tab ${browserId}`,
  ...extra,
});

afterEach(() => {
  cdpTargets = [];
  openTabs = [];
  for (const list of [engineCalls, attached, navigations, evaluations, rdpPicked, rdpCaptures]) list.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_screenshot picks a target when two tabs show the same page", () => {
  it("captures the most recently active Chromium target and names the other instead of refusing", async () => {
    cdpTargets = [page("RECENT"), page("OLDER")];

    const result = JSON.parse(await screenshot.handler({ projectPath: project("chrome"), browser: "chrome", url: "127.0.0.1:8765/index.html" }));

    expect(result.ok).toBe(true);
    expect(result.value.targetId).toBe("RECENT");
    expect(attached).toEqual(["RECENT"]);
    expect(result.warnings.join("\n")).toContain("this used targetId RECENT");
    expect(result.warnings.join("\n")).toContain("The others: OLDER");
  });

  it("captures exactly the target named by targetId and ignores url", async () => {
    cdpTargets = [page("RECENT"), page("OLDER"), page("ELSE", "https://example.com/")];

    const result = JSON.parse(
      await screenshot.handler({ projectPath: project("chrome"), browser: "chrome", url: "example.com", targetId: "OLDER" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.targetId).toBe("OLDER");
    expect(attached).toEqual(["OLDER"]);
  });

  it("refuses a targetId that is gone with E_TARGET_NOT_FOUND naming the live targets", async () => {
    cdpTargets = [page("RECENT")];

    const result = JSON.parse(await screenshot.handler({ projectPath: project("chrome"), browser: "chrome", targetId: "CLOSED" }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(result.error.message).toContain("RECENT");
    expect(result.value.liveTargets).toEqual([{ targetId: "RECENT", url: PAGE }]);
    expect(attached).toEqual([]);
  });

  it("still refuses different pages, and the hint and candidates carry the targetId way out", async () => {
    cdpTargets = [page("A", `${PAGE}#one`), page("B", `${PAGE}#two`)];

    const result = JSON.parse(await screenshot.handler({ projectPath: project("chrome"), browser: "chrome", url: "127.0.0.1:8765/index.html" }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_AMBIGUOUS_TARGET");
    expect(result.hint).toContain("targetId");
    expect(result.value.matchingTargets).toEqual([
      { targetId: "A", url: `${PAGE}#one` },
      { targetId: "B", url: `${PAGE}#two` },
    ]);

    expect(attached).toEqual([]);
  });

  it("on Firefox captures the selected tab among identical ones, else the most recently created", async () => {
    openTabs = [tab(3), tab(7), tab(5)];

    const newest = JSON.parse(await screenshot.handler({ projectPath: project("firefox"), browser: "firefox", url: "127.0.0.1:8765/index.html" }));

    expect(newest.ok).toBe(true);
    expect(rdpCaptures).toEqual([70]);
    expect(newest.value.targetId).toBe("7");
    expect(newest.warnings.join("\n")).toContain("The others: 5, 3");

    openTabs = [tab(3, PAGE, { selected: true }), tab(7)];
    const selected = JSON.parse(await screenshot.handler({ projectPath: project("firefox"), browser: "firefox", url: "127.0.0.1:8765/index.html" }));

    expect(selected.value.targetId).toBe("3");
    expect(rdpCaptures).toEqual([70, 30]);
  });

  it("on Firefox takes the tab's browserId as targetId", async () => {
    openTabs = [tab(3), tab(7)];

    const result = JSON.parse(await screenshot.handler({ projectPath: project("firefox"), browser: "firefox", targetId: "3" }));

    expect(result.ok).toBe(true);
    expect(rdpCaptures).toEqual([30]);
  });
});

describe("extension_dom_snapshot takes a targetId and picks among identical tabs", () => {
  it("reads the target named by targetId over CDP and ignores url", async () => {
    cdpTargets = [page("RECENT"), page("OLDER")];

    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: project("chrome"), browser: "chrome", url: "nothing-matches", targetId: "OLDER" }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations.map((e) => e.sessionId)).toEqual(["session-OLDER"]);
    expect(result.value.target).toEqual({ targetId: "OLDER", url: PAGE, transport: "cdp" });
    expect(engineCalls).toEqual([]);
  });

  it("reads the most recently active of identical tabUrl matches instead of refusing", async () => {
    cdpTargets = [page("RECENT"), page("OLDER")];

    const result = JSON.parse(await domSnapshot.handler({ projectPath: project("chrome"), browser: "chrome", tabUrl: "127.0.0.1:8765/index.html" }));

    expect(result.ok).toBe(true);
    expect(evaluations.map((e) => e.sessionId)).toEqual(["session-RECENT"]);
    expect(result.warnings.join("\n")).toContain("The others: OLDER");
  });

  it("refuses a gone targetId with E_TARGET_NOT_FOUND", async () => {
    openTabs = [tab(3)];

    const result = JSON.parse(await domSnapshot.handler({ projectPath: project("firefox"), browser: "firefox", targetId: "99" }));

    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(result.value.liveTargets).toEqual([{ targetId: "3", url: PAGE }]);
  });
});

describe("extension_inspect takes a targetId and names identical url matches", () => {
  it("attaches to the targetId's target without navigating, url ignored", async () => {
    cdpTargets = [page("RECENT"), page("OLDER")];

    const result = JSON.parse(
      await inspect.handler({ projectPath: project("chrome"), browser: "chrome", url: "https://example.com/", targetId: "OLDER", include: ["meta"] }),
    );

    expect(result.ok).toBe(true);
    expect(attached).toEqual(["OLDER"]);
    expect(navigations).toEqual([]);
    expect(result.value.target.id).toBe("OLDER");
  });

  it("refuses a gone targetId with E_TARGET_NOT_FOUND", async () => {
    cdpTargets = [page("RECENT")];

    const result = JSON.parse(await inspect.handler({ projectPath: project("chrome"), browser: "chrome", targetId: "CLOSED" }));

    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
    expect(attached).toEqual([]);
  });

  it("warns with the other targetIds when a url matches identical tabs", async () => {
    cdpTargets = [page("RECENT"), page("OLDER")];

    const result = JSON.parse(await inspect.handler({ projectPath: project("chrome"), browser: "chrome", url: "127.0.0.1:8765/index.html", include: ["meta"] }));

    expect(attached).toEqual(["RECENT"]);
    expect(result.warnings.join("\n")).toContain("The others: OLDER");
  });

  it("on Firefox reads the targetId's tab over the debugger protocol", async () => {
    openTabs = [tab(3), tab(7, "https://example.com/")];

    const result = JSON.parse(await inspect.handler({ projectPath: project("firefox"), browser: "firefox", targetId: "7", include: ["meta"] }));

    expect(result.ok).toBe(true);
    expect(rdpPicked.map((t) => t?.browserId)).toEqual([7]);
    expect(result.value.target).toEqual({ targetId: "7", url: "https://example.com/", title: "tab 7" });
    expect(engineCalls).toEqual([]);
  });
});

describe("extension_eval takes a targetId", () => {
  it("evaluates in the targetId's target over CDP, url ignored", async () => {
    cdpTargets = [page("RECENT"), page("OLDER")];

    const result = JSON.parse(
      await evalTool.handler({ projectPath: project("chrome"), browser: "chrome", context: "page", url: "elsewhere", targetId: "OLDER", expression: "1" }),
    );

    expect(result.ok).toBe(true);
    expect(evaluations.map((e) => e.sessionId)).toEqual(["session-OLDER"]);
  });

  it("refuses a gone targetId with E_TARGET_NOT_FOUND, and refuses without the eval token", async () => {
    cdpTargets = [page("RECENT")];

    const gone = JSON.parse(await evalTool.handler({ projectPath: project("chrome"), browser: "chrome", targetId: "CLOSED", expression: "1" }));
    expect(gone.error.code).toBe("E_TARGET_NOT_FOUND");

    const disabled = JSON.parse(await evalTool.handler({ projectPath: project("chrome", false), browser: "chrome", targetId: "RECENT", expression: "1" }));
    expect(disabled.error.code).toBe("E_EVAL_DISABLED");
    expect(evaluations).toEqual([]);
  });

  it("on Firefox evaluates in the tab whose browserId is the targetId", async () => {
    openTabs = [tab(3, PAGE, { selected: true }), tab(7)];

    const result = JSON.parse(await evalTool.handler({ projectPath: project("firefox"), browser: "firefox", targetId: "7", expression: "document.title" }));

    expect(result.ok).toBe(true);
    expect(rdpPicked.map((t) => t?.browserId)).toEqual([7]);
  });
});

describe("every tool that takes targetId says so and where to get it", () => {
  it("lists targetId in the four readers' schemas and points extension_open's answer at them", () => {
    for (const tool of [screenshot, domSnapshot, inspect, evalTool]) {
      const props = tool.schema.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.targetId?.description, tool.schema.name).toContain("extension_open");
      expect(tool.schema.description, tool.schema.name).toContain("targetId");
    }

    expect(open.schema.description).toContain("target.targetId");
    expect(open.schema.description).toContain("extension_screenshot");
  });
});
