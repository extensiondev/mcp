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
import { actVerbAnswer, evalRefusal } from "./fixtures/engine-answers";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

type Call = { cli: string[]; expression: string };
const calls: Call[] = [];
let respond: (call: Call, index: number) => string = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      const at = cli.indexOf("--");
      const call = { cli, expression: at === -1 ? "" : cli[at + 1] };
      calls.push(call);

      return respond(call, calls.length - 1);
    },
  };
});

let rdpPort: number | null = 9224;
vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => null,
    resolveRdpPort: async () =>
      rdpPort === null ? null : { port: rdpPort, source: "contract" as const },
  };
});

let openTabs: RdpTab[] = [];
const picked: Array<RdpTab | null | undefined> = [];

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => openTabs,
    rdpEvaluateInTab: async (
      _port: number,
      options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined; expression: string },
    ) => {
      const tab = options.select(openTabs);
      picked.push(tab);
      if (!tab) return { ok: false, name: "TargetNotFound", message: "no open tab matches" };

      return { ok: true, value: tab.title, tab: { url: String(tab.url), title: String(tab.title ?? "") } };
    },
  };
});

const evalTool = await import("../tools/eval");

const BASE = "moz-extension://4a93ac70-455d-4566-af3c-7a794be7f33e/";
const SIDEBAR_TAB: RdpTab = { actor: "tab3", url: `${BASE}sidebar/index.html`, title: "Sidebar Extension", selected: true };
const WEB_TAB: RdpTab = { actor: "tab1", url: "https://example.com/", title: "Example Domain" };

const dirs: string[] = [];

function project(manifestVersion: 2 | 3): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gecko-ext-tab-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({
      manifest_version: manifestVersion,
      name: "Sidebar",
      sidebar_action: { default_panel: "sidebar/index.html" },
      background: { scripts: ["background.js"] },
    }),
  );

  return dir;
}

const noScripting = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_NOT_IMPLEMENTED",
      name: "Unsupported",
      message: 'chrome.scripting is not available on this engine (MV2 has no scripting API); use context: "background"',
      engine: "firefox",
    }),
    "extension_eval",
  );

const injectionRefused = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_TARGET_NOT_FOUND",
      name: "TargetNotFound",
      message: "Missing host permission for the tab",
      engine: "firefox",
    }),
    "extension_eval",
  );

const executeScriptRefused = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: { error: "Missing host permission for the tab" } });

const engineFor = (manifestVersion: 2 | 3) => (_call: Call, index: number) =>
  manifestVersion === 3 ? injectionRefused() : index === 0 ? noScripting() : executeScriptRefused();

afterEach(() => {
  calls.length = 0;
  picked.length = 0;
  openTabs = [];
  rdpPort = 9224;
  respond = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval context page on a Firefox tab that shows the extension's own page", () => {
  it("evaluates a relative document url over the debugger protocol on an MV2 build", async () => {
    const dir = project(2);
    openTabs = [WEB_TAB, SIDEBAR_TAB];
    respond = engineFor(2);

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "sidebar/index.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Sidebar Extension");
    expect(picked[picked.length - 1]?.actor).toBe("tab3");
    expect(calls.some((call) => call.expression.includes("executeScript"))).toBe(false);
  });

  it.each([2, 3] as const)(
    "evaluates the active extension tab over the debugger protocol when no url is given (MV%s)",
    async (manifestVersion) => {
      const dir = project(manifestVersion);
      openTabs = [WEB_TAB, SIDEBAR_TAB];
      respond = engineFor(manifestVersion);

      const result = JSON.parse(
        await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", expression: "document.title" }),
      );

      expect(result.ok).toBe(true);
      expect(result.value).toBe("Sidebar Extension");
      expect(picked[picked.length - 1]?.actor).toBe("tab3");
      expect(String(result.warnings)).toContain('url: "sidebar/index.html"');
    },
  );

  it("keeps tabs.executeScript for an active web page on an MV2 build", async () => {
    const dir = project(2);
    openTabs = [{ ...WEB_TAB, selected: true }, { ...SIDEBAR_TAB, selected: false }];
    respond = (_call, index) =>
      index === 0
        ? noScripting()
        : envelope({
            ok: true,
            command: "extension_eval",
            status: "ok",
            value: { frames: [{ __extensionDevExec: 1, ok: true, value: "Example Domain" }] },
          });

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", expression: "document.title" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Example Domain");
    expect(calls[1].expression).toContain("executeScript");
    expect(picked).toHaveLength(0);
  });

  it("names the surface context and the url route when the tab cannot be read over the protocol", async () => {
    const dir = project(2);
    rdpPort = null;
    respond = engineFor(2);

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", expression: "document.title" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("Missing host permission for the tab");
    expect(result.hint).toContain('context: "sidebar"');
    expect(result.hint).toContain("url");
  });
});
