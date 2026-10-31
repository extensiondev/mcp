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
import { actVerbAnswer, evalRefusal } from "./fixtures/engine-answers";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

const calls: string[][] = [];
let respond: (cli: string[]) => string = () => envelope({ ok: true, command: "x", status: "ok", value: 1 });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);

      return respond(cli);
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => null,
    resolveRdpPort: async () => ({ port: 9222, source: "contract" as const }),
  };
});

const WEB_TAB: RdpTab = { actor: "tab3", url: "http://127.0.0.1:8731/", title: "site", selected: true, browserId: 3 };
const OTHER_TAB: RdpTab = { actor: "tab1", url: "https://example.com/", title: "Example", browserId: 1 };
let openTabs: RdpTab[] = [WEB_TAB, OTHER_TAB];
const rdpReads: Array<{ expression: string; picked: RdpTab | null | undefined }> = [];

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => openTabs,
    rdpCollectConsoleMessages: async () => [],
    rdpEvaluateInTab: async (
      _port: number,
      options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined; expression: string },
    ) => {
      const picked = options.select(openTabs);
      rdpReads.push({ expression: options.expression, picked });
      if (!picked) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };

      const value = options.expression.includes("querySelectorAll(\"script\")") && options.expression.includes("context: \"page\"")
        ? { context: "page", url: picked.url, title: picked.title, summary: { bodyChildCount: 1 } }
        : options.expression.includes("probes")
          ? { meta: { url: picked.url, title: picked.title }, summary: { bodyChildCount: 1 }, probes: [{ selector: "#h", count: 1 }] }
          : "hello";

      return { ok: true, value, tab: { url: String(picked.url), title: String(picked.title ?? "") } };
    },
  };
});

const evalTool = await import("../tools/eval");
const inspectTool = await import("../tools/inspect");
const snapshotTool = await import("../tools/dom-snapshot");

const dirs: string[] = [];

function project(manifestVersion: 2 | 3, command: "start" | "dev" = "start"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ff-start-reads-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({ manifest_version: manifestVersion, name: "Lens", background: { scripts: ["background.js"] } }),
  );

  const contract = readyContractPath(dir, "firefox");
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  fs.writeFileSync(contract, JSON.stringify({ schema: 1, status: "ready", command, browser: "firefox", rdpPort: 9222, pid: process.pid }));

  return dir;
}

const noScripting = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_NOT_IMPLEMENTED",
      name: "Unsupported",
      message: "chrome.scripting is not available on this engine (MV2 has no scripting API); use --context background",
      engine: "firefox",
    }),
    "extension_eval",
  );

const tabIdAskedFor = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_NOT_IMPLEMENTED",
      name: "Unsupported",
      message: "inspect of content requires a tabId (content/page) or an open surface",
      engine: "firefox",
    }),
    "extension_dom_snapshot",
  );

const tabList = () =>
  envelope({
    ok: true,
    command: "extension_dom_snapshot",
    status: "ok",
    value: [
      { id: 1, url: OTHER_TAB.url, title: "Example", active: false },
      { id: 3, url: WEB_TAB.url, title: "site", active: true },
    ],
  });

const isListTabs = (cli: string[]) => cli.includes("--list-tabs");
const executeScriptCalls = () => calls.filter((cli) => cli.some((part) => part.includes("executeScript")));

afterEach(() => {
  calls.length = 0;
  rdpReads.length = 0;
  openTabs = [WEB_TAB, OTHER_TAB];
  respond = () => envelope({ ok: true, command: "x", status: "ok", value: 1 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("page reads on a Firefox MV3 start session go over the debugger protocol (ledger 330)", () => {
  it("evaluates context page in the tab the url names and never calls tabs.executeScript", async () => {
    const dir = project(3);
    respond = (cli) => (isListTabs(cli) ? tabList() : noScripting());

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "127.0.0.1:8731", expression: "1 + 1" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("hello");
    expect(rdpReads[rdpReads.length - 1]?.picked?.actor).toBe("tab3");
    expect(executeScriptCalls()).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("debugger protocol");
    expect(result.warnings.join(" ")).toContain("\"scripting\" permission");
    expect(JSON.stringify(result)).not.toContain("Check the expression itself");
  });

  it("picks a numeric tab by the url the bridge lists for it", async () => {
    const dir = project(3);
    respond = (cli) => (isListTabs(cli) ? tabList() : noScripting());

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", tab: 1, expression: "1 + 1" }),
    );

    expect(result.ok).toBe(true);
    expect(rdpReads[rdpReads.length - 1]?.picked?.actor).toBe("tab1");
  });

  it("refuses context content in words that name the missing scripting route", async () => {
    const dir = project(3);
    respond = (cli) => (isListTabs(cli) ? tabList() : noScripting());

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "content", url: "127.0.0.1:8731", expression: "1 + 1" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("ContentWorldUnreachable");
    expect(result.error.message).toContain("tabs.executeScript");
    expect(result.error.code).not.toBe("E_EVAL");
    expect(executeScriptCalls()).toHaveLength(0);
  });

  it("keeps the tabs.executeScript route on an MV2 build", async () => {
    const dir = project(2);
    respond = (cli) =>
      cli.includes("background")
        ? envelope({ ok: true, command: "extension_eval", status: "ok", value: { frames: [{ __extensionDevExec: 1, ok: true, value: 2 }] } })
        : noScripting();

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "127.0.0.1:8731", expression: "1 + 1" }),
    );

    expect(result.value).toBe(2);
    expect(executeScriptCalls().length).toBeGreaterThan(0);
  });

  it("inspects the tab over the debugger protocol", async () => {
    const dir = project(3);
    respond = (cli) => (isListTabs(cli) ? tabList() : noScripting());

    const result = JSON.parse(
      await inspectTool.handler({ projectPath: dir, browser: "firefox", url: "127.0.0.1:8731", probe: ["#h"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.transport).toBe("rdp");
    expect(result.value.probes[0].count).toBe(1);
    expect(executeScriptCalls()).toHaveLength(0);
  });
});

describe("extension_dom_snapshot on a Firefox MV3 start session reads the tab it resolved (ledger 331)", () => {
  it("snapshots the tab tabUrl resolved instead of asking for a tabId", async () => {
    const dir = project(3);
    respond = (cli) => (isListTabs(cli) ? tabList() : tabIdAskedFor());

    const result = JSON.parse(
      await snapshotTool.handler({ projectPath: dir, browser: "firefox", tabUrl: "127.0.0.1:8731" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.url).toBe(WEB_TAB.url);
    expect(result.value.resolvedTarget.tabId).toBe(3);
    expect(rdpReads[rdpReads.length - 1]?.picked?.actor).toBe("tab3");
    expect(JSON.stringify(result)).not.toContain("requires a tabId");
  });

  it("snapshots a numeric tab the same way", async () => {
    const dir = project(3);
    respond = (cli) => (isListTabs(cli) ? tabList() : tabIdAskedFor());

    const result = JSON.parse(await snapshotTool.handler({ projectPath: dir, browser: "firefox", tab: 1 }));

    expect(result.ok).toBe(true);
    expect(rdpReads[rdpReads.length - 1]?.picked?.actor).toBe("tab1");
  });

  it("leaves the engine's tabId refusal alone on a dev session", async () => {
    const dir = project(3, "dev");
    respond = (cli) => (isListTabs(cli) ? tabList() : tabIdAskedFor());

    const result = JSON.parse(await snapshotTool.handler({ projectPath: dir, browser: "firefox", tab: 1 }));

    expect(result.ok).toBe(false);
    expect(rdpReads).toHaveLength(0);
  });
});
