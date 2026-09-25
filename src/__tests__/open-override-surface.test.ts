import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cliCalls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      cliCalls.push(cli);
      return JSON.stringify({
        schema: 1,
        ok: false,
        command: "extension_open",
        status: "usage",
        value: null,
        error: {
          code: "E_ARGS",
          name: "CliError",
          message: `unknown surface: ${cli[1]} (use popup, options, sidebar, action, or command)`,
        },
        warnings: [],
      });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222 }) };
});

const navigations: string[] = [];
let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> =
  [];
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget() {
      return "session-1";
    }
    async navigate(_session: string, url: string) {
      navigations.push(url);
      cdpTargets = [
        ...cdpTargets.filter((t) => t.type !== "page"),
        { id: "navigated", type: "page", url, title: "Landed" },
      ];
    }
    async evaluate() {
      return null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const url = String(params?.url ?? "");
        navigations.push(url);
        cdpTargets = [...cdpTargets, { id: "created", type: "page", url }];
        return { targetId: "created" };
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const open = await import("../tools/open");

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
function project(manifest: Record<string, unknown>): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-override-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify(manifest),
  );
  const distPath = path.join(dir, "dist", "chrome");
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify({ status: "ready", distPath }),
  );
  return { dir, id: expectedId(distPath) };
}

afterEach(() => {
  cliCalls.length = 0;
  navigations.length = 0;
  cdpTargets = [];
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_open resolves override pages itself: the engine's open verb does not know them", () => {
  it("opens surface newtab by url without asTab and never asks the engine", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      chrome_url_overrides: { newtab: "chrome_url_overrides/newtab.html" },
    });
    cdpTargets = [{ id: "blank", type: "page", url: "about:blank" }];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "newtab" }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("navigated");
    expect(navigations).toEqual([
      `chrome-extension://${p.id}/chrome_url_overrides/newtab.html`,
    ]);
    expect(result.value.renderedAsTab).toMatchObject({
      surface: "newtab",
      document: "chrome_url_overrides/newtab.html",
      extensionId: p.id,
    });
    expect(result.hint).toContain("real surface");
    expect(result.hint).not.toContain("NOT hosted in a popup window");
    expect(result.hint).toContain("extension_eval with context: 'newtab'");
  });

  it("does the same for history and bookmarks", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      chrome_url_overrides: { history: "history.html", bookmarks: "marks.html" },
    });
    cdpTargets = [{ id: "blank", type: "page", url: "about:blank" }];

    const history = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "history" }),
    );
    const bookmarks = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "bookmarks" }),
    );

    expect(cliCalls).toEqual([]);
    expect(history.ok).toBe(true);
    expect(bookmarks.ok).toBe(true);
    expect(navigations).toEqual([
      `chrome-extension://${p.id}/history.html`,
      `chrome-extension://${p.id}/marks.html`,
    ]);
  });

  it("says the manifest declares no such override instead of forwarding the surface", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "newtab" }),
    );

    expect(cliCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(result.error.message).toContain("chrome_url_overrides.newtab");
    expect(result.value.declaredSurfaces).toEqual(["popup"]);
  });

  it("still hands popup to the engine, which knows it", async () => {
    const p = project({
      manifest_version: 3,
      name: "F",
      action: { default_popup: "popup.html" },
    });

    await open.handler({ projectPath: p.dir, surface: "popup" });

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].slice(0, 2)).toEqual(["open", "popup"]);
  });
});
