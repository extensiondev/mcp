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
import { actFailure, actVerbAnswer, evalRefusal, readyContract } from "./fixtures/engine-answers";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

const calls: string[][] = [];
let respond: (cli: string[]) => string = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });

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

      const value = options.expression.includes("outerHTML")
        ? { context: "page", url: tab.url, title: tab.title, summary: { htmlLength: 512 } }
        : tab.title;

      return { ok: true, value, tab: { url: String(tab.url), title: String(tab.title ?? "") } };
    },
  };
});

const evalTool = await import("../tools/eval");
const domSnapshot = await import("../tools/dom-snapshot");
const openTool = await import("../tools/open");

const BASE = "moz-extension://5b0c1f8e-2d7a-4c55-9a43-0f1e6c2b7d10/";
const OPTIONS_TAB: RdpTab = { actor: "tab2", url: `${BASE}options/index.html`, title: "PII Shield settings" };
const WEB_TAB: RdpTab = { actor: "tab1", url: "http://127.0.0.1:8765/veil.html", title: "Veil fixture" };

const dirs: string[] = [];

function project(command: "start" | "preview" | "dev"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gecko-ext-pages-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "PII Shield",
      options_ui: { page: "options/index.html", open_in_tab: true },
      background: { scripts: ["background/scripts.js"] },
    }),
  );

  const contractDir = path.join(dir, "dist", "extension-js", "firefox");
  fs.mkdirSync(contractDir, { recursive: true });
  fs.writeFileSync(
    path.join(contractDir, "ready.json"),
    JSON.stringify(
      readyContract(command, "firefox", {
        distPath: path.join(contractDir, "controlled"),
        controlPort: 61110,
        extensionId: "pii-shield@extension.dev",
      }),
    ),
  );

  return dir;
}

const surfaceNotOpen = (tool: string, op: "eval" | "inspect") =>
  actVerbAnswer(
    op === "eval"
      ? evalRefusal({
          code: "E_TARGET_NOT_FOUND",
          name: "Unsupported",
          message: "surface 'options' is not open (open it first: extension open options)",
          engine: "firefox",
        })
      : actFailure(
          "inspect",
          {
            code: "E_TARGET_NOT_FOUND",
            name: "Unsupported",
            message: "surface 'options' is not open (open it first: extension open options)",
            engine: "firefox",
          },
          "not-found",
        ),
    tool,
  );

const missingHostPermission = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_TARGET_NOT_FOUND",
      name: "TargetNotFound",
      message: "Missing host permission for the tab",
      engine: "firefox",
    }),
    "extension_eval",
  );

afterEach(() => {
  calls.length = 0;
  picked.length = 0;
  openTabs = [];
  rdpPort = 9224;
  respond = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("a Firefox start session reaches the extension's own pages over the debugger protocol", () => {
  it("evaluates context options in the tab that shows the options document", async () => {
    const dir = project("start");
    openTabs = [WEB_TAB, OPTIONS_TAB];
    respond = () => surfaceNotOpen("extension_eval", "eval");

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "options", expression: "document.title" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("PII Shield settings");
    expect(picked[picked.length - 1]?.actor).toBe("tab2");
  });

  it("evaluates context page with the options url instead of reporting the tab as not found", async () => {
    const dir = project("preview");
    openTabs = [WEB_TAB, OPTIONS_TAB];
    respond = () => missingHostPermission();

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "options/index.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("PII Shield settings");
    expect(picked[picked.length - 1]?.actor).toBe("tab2");
  });

  it("keeps the engine's answer for a web url that no extension tab shows", async () => {
    const dir = project("start");
    openTabs = [OPTIONS_TAB];
    respond = () => missingHostPermission();

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "example.com",
        expression: "document.title",
      }),
    );

    expect(result.error.message).toBe("Missing host permission for the tab");
    expect(picked).toHaveLength(0);
  });

  it("snapshots context options from the tab that shows it", async () => {
    const dir = project("start");
    openTabs = [WEB_TAB, OPTIONS_TAB];
    respond = () => surfaceNotOpen("extension_dom_snapshot", "inspect");

    const result = JSON.parse(
      await domSnapshot.handler({ projectPath: dir, browser: "firefox", context: "options" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.url).toBe(OPTIONS_TAB.url);
    expect(result.value.summary.htmlLength).toBe(512);
  });

  it("confirms an opened options page from the debugger protocol's tab list", async () => {
    const dir = project("start");
    openTabs = [WEB_TAB, OPTIONS_TAB];
    respond = () =>
      envelope({ ok: true, command: "extension_open", status: "ok", value: { surface: "options", opened: true } });

    const result = JSON.parse(
      await openTool.handler({ projectPath: dir, browser: "firefox", surface: "options" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.confirmed).toBe(true);
    expect(result.value.surfaceTarget.url).toBe(OPTIONS_TAB.url);
  });
});

describe("a Firefox start session with no debugger port says it cannot reach extension pages", () => {
  it.each([
    ["extension_eval context options", () => ({ tool: evalTool, args: { context: "options", expression: "document.title" }, op: "eval" as const })],
    ["extension_dom_snapshot context options", () => ({ tool: domSnapshot, args: { context: "options" }, op: "inspect" as const })],
  ])("%s answers E_EXTENSION_PAGE_UNREACHABLE and names extension_dev", async (_name, cell) => {
    const dir = project("start");
    rdpPort = null;
    const { tool, args, op } = cell();
    respond = () => surfaceNotOpen(op === "eval" ? "extension_eval" : "extension_dom_snapshot", op);

    const result = JSON.parse(
      await (tool.handler as unknown as (a: Record<string, unknown>) => Promise<string>)({ projectPath: dir, browser: "firefox", ...args }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_EXTENSION_PAGE_UNREACHABLE");
    expect(result.error.message).toMatch(/cannot reach extension pages on a firefox start/i);
    expect(result.hint).toContain("extension_dev");
  });

  it("says no tab shows the surface instead of calling it not found when it may sit in its own window", async () => {
    const dir = project("start");
    openTabs = [WEB_TAB];
    respond = () => surfaceNotOpen("extension_eval", "eval");

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "options", expression: "document.title" }),
    );

    expect(result.error.code).toBe("E_EXTENSION_PAGE_UNREACHABLE");
    expect(result.error.message).toContain("no tab shows it now");
    expect(picked).toHaveLength(0);
  });

  it("leaves a dev session's not-open answer alone, since its pages carry the relay", async () => {
    const dir = project("dev");
    rdpPort = null;
    respond = () => surfaceNotOpen("extension_eval", "eval");

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "options", expression: "document.title" }),
    );

    expect(result.error.code).toBe("E_TARGET_NOT_FOUND");
  });
});
