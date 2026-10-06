import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const openedFrame = () =>
  envelope({
    ok: true,
    command: "extension_open",
    status: "ok",
    value: { opened: "options" },
  });

let actResult = openedFrame();
let cdpTargets: Array<{ id: string; type: string; url: string }> = [];
const actCalls: string[][] = [];
const attached: string[] = [];
let nextCreatedId = 0;

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      actCalls.push(cli);
      return actResult;
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222 }) };
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
    async attachToTarget(id: string) {
      attached.push(id);
      return `session-${id}`;
    }
    async enableDomains() {}
    async navigate(sessionId: string, url: string) {
      const id = sessionId.replace(/^session-/, "");
      cdpTargets = cdpTargets.map((t) => (t.id === id ? { ...t, url } : t));
    }
    async evaluate() {
      return null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const id = `created-${++nextCreatedId}`;
        cdpTargets = [...cdpTargets, { id, type: "page", url: String(params?.url ?? "") }];
        return { targetId: id };
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
function project(): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-confirm-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "F",
      options_ui: { page: "options.html" },
    }),
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
  actResult = openedFrame();
  cdpTargets = [];
  actCalls.length = 0;
  attached.length = 0;
  open.renderedTabTargets.clear();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_open surface confirmation", () => {
  it("never reports a surface opened when no document target appears: it renders the tab and says so", async () => {
    const p = project();

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "options" }),
    );

    expect(result.value.surfaceTarget).toBeUndefined();
    expect(result.value.confirmed).not.toBe(true);
    expect(result.value.renderedAsTab).toMatchObject({ surface: "options", document: "options.html" });
    expect(result.warnings.join("\n")).toMatch(/no document for it appeared within 3s.*rendered in a tab instead/);
    expect(result.value.engineResult.value.opened).toBe("options");
  }, 15_000);

  it("confirms and names the target when the surface really opened", async () => {
    const p = project();
    cdpTargets = [
      {
        id: "opt",
        type: "page",
        url: `chrome-extension://${p.id}/options.html`,
      },
    ];

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "options" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.surfaceTarget).toEqual({
      targetId: "opt",
      url: `chrome-extension://${p.id}/options.html`,
    });
  });

  /*. */
  it("refuses an options open before asking the engine when the manifest declares none", async () => {
    const p = project();
    fs.writeFileSync(
      path.join(p.dir, "src", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "F", action: { default_popup: "popup.html" } }),
    );

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("no-surface");
    expect(actCalls).toHaveLength(0);
  });

  it("says the open is unconfirmed on an engine without a CDP target list", async () => {
    const p = project();

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, browser: "firefox", surface: "options" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.confirmed).toBe(false);
    expect(result.value.confirmation).toMatch(/firefox has none/);
    expect(result.warnings.join("\n")).toMatch(/could not confirm a document/);
  });

  it("never counts a tab this server rendered as the opened window", async () => {
    const p = project();
    const optionsUrl = `chrome-extension://${p.id}/options.html`;
    cdpTargets = [{ id: "opt-tab", type: "page", url: optionsUrl }];
    const rendered = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options", asTab: true }));
    expect(rendered.ok).toBe(true);
    expect(open.renderedTabTargets.has("opt-tab")).toBe(true);

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options" }));

    expect(result.value?.surfaceTarget?.targetId).not.toBe("opt-tab");
    expect(result.value?.confirmed).not.toBe(true);
    expect(JSON.stringify(result)).toMatch(/rendered in a tab instead|surface-did-not-open/);
  }, 20_000);

  it("never navigates a live side panel in place when re-rendering another surface as a tab", async () => {
    const p = project();
    fs.writeFileSync(
      path.join(p.dir, "src", "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "F",
        options_ui: { page: "options.html" },
        side_panel: { default_path: "sidebar.html" },
      }),
    );
    cdpTargets = [{ id: "panel", type: "page", url: `chrome-extension://${p.id}/sidebar.html` }];

    const result = JSON.parse(await open.handler({ projectPath: p.dir, surface: "options", asTab: true }));

    expect(result.ok).toBe(true);
    expect(attached).not.toContain("panel");
    expect(cdpTargets.find((t) => t.id === "panel")?.url).toBe(`chrome-extension://${p.id}/sidebar.html`);
    expect(result.value.target.targetId).toMatch(/^created-/);
  });

  it("passes an engine failure through untouched", async () => {
    const p = project();
    actResult = envelope({
      ok: false,
      command: "extension_open",
      status: "failed",
      error: { code: "E_SESSION_NOT_FOUND", name: "CliError", message: "No active control channel found for chrome. Looked at /p/dist/extension-js/chrome/ready.json. Run `extension dev --browser=chrome --allow-control` first." },
    });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "options" }),
    );

    expect(result.error.code).toBe("E_SESSION_NOT_FOUND");
    expect(result.value?.renderedAsTab).toBeUndefined();
  });
});
