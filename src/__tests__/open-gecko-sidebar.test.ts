import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const refusal = () =>
  JSON.stringify({
    schema: 1,
    ok: false,
    command: "extension_open",
    status: "failed",
    value: null,
    error: {
      name: "Unsupported",
      message: "sidePanel not available (engine: firefox)",
      engine: "firefox",
      code: "E_NOT_IMPLEMENTED",
    },
    warnings: [],
  });

const calls: string[][] = [];
let openResult: () => string = refusal;
let panelOpen = true;
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      if (cli[0] === "open") return openResult();
      if (cli[0] === "inspect") {
        return panelOpen
          ? envelope({
              ok: true,
              command: "extension_open",
              status: "ok",
              value: {
                context: "sidebar",
                url: "moz-extension://abc/sidebar/index.html",
                title: "Sidebar",
                summary: { bodyChildCount: 2 },
              },
            })
          : envelope({
              ok: false,
              command: "extension_open",
              status: "not-found",
              error: {
                code: "E_TARGET_NOT_FOUND",
                name: "Unsupported",
                message: "surface 'sidebar' is not open",
              },
            });
      }
      return envelope({ ok: true, command: "extension_open", status: "ok", value: null });
    },
  };
});

const navigations: string[] = [];
vi.mock("../lib/bridge-tabs", () => ({
  listBridgeTabs: async () => ({ tabs: [] }),
  resolveBridgeBaseUrl: async () => "moz-extension://abc/",
  navigateToUrlViaBridge: async (_p: string, _b: string, url: string) => {
    navigations.push(url);
    return envelope({
      ok: true,
      command: "extension_open",
      status: "navigated",
      value: { navigated: url, tabId: 3, via: "navigate" },
    });
  },
}));

const open = await import("../tools/open");

const dirs: string[] = [];
function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-gecko-sidebar-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const MANIFEST = {
  manifest_version: 2,
  name: "F",
  sidebar_action: { default_panel: "sidebar/index.html" },
};

afterEach(() => {
  calls.length = 0;
  navigations.length = 0;
  openResult = refusal;
  panelOpen = true;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_open sidebar on Gecko when the engine names a Chromium API it does not have", () => {
  it("reports a panel that is already open instead of refusing", async () => {
    const dir = project(MANIFEST);

    const result = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "sidebar" }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("already-open");
    expect(result.value).toMatchObject({
      surface: "sidebar",
      document: "sidebar/index.html",
      alreadyOpen: true,
      url: "moz-extension://abc/sidebar/index.html",
    });
    expect(result.hint).toContain("context: 'sidebar'");
    expect(result.hint).toContain("user gesture");
    expect(JSON.stringify(result)).not.toContain("sidePanel");
    const probe = calls.find((c) => c[0] === "inspect");
    expect(probe).toBeDefined();
    expect(probe?.[probe.indexOf("--context") + 1]).toBe("sidebar");
    expect(navigations).toEqual([]);
  });

  it("renders the sidebar document as a tab when the panel is closed, and states the gesture rule", async () => {
    const dir = project(MANIFEST);
    panelOpen = false;

    const result = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "sidebar" }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(navigations).toEqual(["moz-extension://abc/sidebar/index.html"]);
    expect(result.value.renderedAsTab).toMatchObject({
      surface: "sidebar",
      document: "sidebar/index.html",
    });
    const warning = result.warnings.find((w: string) => w.includes("user gesture"));
    expect(warning).toContain("1392624");
    expect(warning).toContain("rendered as a tab");
    expect(JSON.stringify(result)).not.toContain("sidePanel");
  });

  it("says the manifest declares no sidebar rather than probing", async () => {
    const dir = project({ manifest_version: 2, name: "F", browser_action: {} });

    const result = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "sidebar" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(calls.filter((c) => c[0] === "inspect")).toEqual([]);
  });

  it("passes an engine success and unrelated failures through untouched", async () => {
    const dir = project(MANIFEST);
    openResult = () =>
      envelope({ ok: true, command: "extension_open", status: "ok", value: { opened: "sidebar" } });
    const opened = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "sidebar" }),
    );
    expect(opened.value.opened).toBe("sidebar");

    openResult = () =>
      envelope({
        ok: false,
        command: "extension_open",
        status: "no-session",
        error: { code: "E_NO_SESSION", name: "NoSession", message: "no session" },
      });
    const failed = JSON.parse(
      await open.handler({ projectPath: dir, browser: "firefox", surface: "sidebar" }),
    );
    expect(failed.error.code).toBe("E_NO_SESSION");
    expect(calls.filter((c) => c[0] === "inspect")).toEqual([]);
  });
});
