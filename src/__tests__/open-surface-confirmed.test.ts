import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `extension open options` answers {"opened":"options"} whether or not a
// document ever appears. Four personas took that at face value, inspected a
// surface that was not there, and were told by dom_inspect to run the call that
// had already claimed success. Ask the browser, not the CLI.
let actResult = JSON.stringify({ ok: true, opened: "options" });
let cdpTargets: Array<{ id: string; type: string; url: string }> = [];

vi.mock("../lib/act", () => ({
  runActVerb: async () => actResult,
}));

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
    async attachToTarget() {
      return "session-1";
    }
    async navigate() {}
    async sendCommand() {
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
  actResult = JSON.stringify({ ok: true, opened: "options" });
  cdpTargets = [];
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_open surface confirmation", () => {
  it("refuses to report a surface opened when no document target appears", async () => {
    const p = project();

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "options" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("SurfaceDidNotOpen");
    expect(result.error.message).toContain("nothing is there to inspect");
    expect(result.hint).toContain("asTab: true");
    // The engine's own answer is kept, not hidden.
    expect(result.engineResult.opened).toBe("options");
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
    expect(result.surfaceTarget).toEqual({
      targetId: "opt",
      url: `chrome-extension://${p.id}/options.html`,
    });
  });

  it("passes an engine failure through untouched", async () => {
    const p = project();
    actResult = JSON.stringify({
      ok: false,
      error: { name: "NoSession", message: "no session" },
    });

    const result = JSON.parse(
      await open.handler({ projectPath: p.dir, surface: "options" }),
    );

    expect(result.error.name).toBe("NoSession");
  });
});
