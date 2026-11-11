import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { writeEvalToken } from "./fixtures/ready-contract";
import { unpackedExtensionId } from "../lib/extension-identity";
import { filterDocumentTargets } from "../lib/cdp-targets";
import { matchExtensionPageTargets } from "../lib/cdp-extension-page";

import type * as CdpPortModule from "../lib/cdp-port";

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

type Target = { id: string; type: string; url: string; title: string };
let cdpTargets: Target[] = [];
vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverTargets() {
      return cdpTargets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async attachToTarget(targetId: string) {
      return `session-${targetId}`;
    }
    async sendCommand() {
      return { result: { type: "string", value: "panel" } };
    }
    disconnect() {}
  }

  return { CDPClient };
});

const opens: Array<Record<string, unknown>> = [];
let openReply: () => string = () =>
  JSON.stringify({ ok: false, command: "extension_open", status: "no-session", error: { code: "E_NO_SESSION", name: "NoSession", message: "no live session answers in this cell" } });
vi.mock("../tools/open", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    handler: async (args: Record<string, unknown>) => {
      opens.push(args);

      return openReply();
    },
  };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];

function project(): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-sidebar-"));
  dirs.push(dir);
  const distPath = path.join(dir, "dist", "chrome");
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(
    path.join(distPath, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "F", side_panel: { default_path: "sidebar/index.html" }, permissions: ["sidePanel"] }),
  );

  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify({ status: "ready", distPath }));
  writeEvalToken(dir, "chrome");

  return { dir, id: unpackedExtensionId(distPath) };
}

afterEach(() => {
  cdpTargets = [];
  opens.length = 0;
  openReply = () =>
    JSON.stringify({ ok: false, command: "extension_open", status: "no-session", error: { code: "E_NO_SESSION", name: "NoSession", message: "no live session answers in this cell" } });

  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("404: a Chrome side panel is a page target at its document url, and a closed one is refused with what is open", () => {
  it("evaluates in the open side panel, which Chrome lists as a page target at side_panel.default_path (probed 2026-11-05 on Chrome for Testing 1248)", async () => {
    const p = project();
    const panel = `chrome-extension://${p.id}/sidebar/index.html`;
    cdpTargets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/bg.js`, title: "" },
      { id: "tab", type: "page", url: "https://www.youtube.com/watch?v=1", title: "YouTube" },
      { id: "panel", type: "page", url: panel, title: "Panel" },
    ];

    const result = JSON.parse(await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "sidebar", expression: "location.href" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("evaluated");
    expect(result.hint).toContain(panel);
  });

  it("matches a panel whose url carries a query or a fragment", () => {
    const docs = filterDocumentTargets([
      { id: "a", type: "page", url: "chrome-extension://abc/sidebar/index.html?tab=3", title: "" },
      { id: "b", type: "page", url: "chrome-extension://abc/sidebar/index.html#home", title: "" },
      { id: "c", type: "other", url: "", title: "" },
    ]);

    expect(matchExtensionPageTargets(docs, "chrome-extension://abc/sidebar/index.html").map((t) => t.targetId)).toEqual(["a", "b"]);
  });

  it("518: opens a closed panel the way extension_open does, evaluates in it and says opened: true", async () => {
    const p = project();
    const panel = `chrome-extension://${p.id}/sidebar/index.html`;
    cdpTargets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/bg.js`, title: "" },
      { id: "tab", type: "page", url: "https://www.youtube.com/", title: "YouTube" },
    ];

    openReply = () => {
      cdpTargets = [...cdpTargets, { id: "panel", type: "page", url: panel, title: "Panel" }];

      return JSON.stringify({ ok: true, command: "extension_open", status: "ok", value: { surface: "sidebar", opened: true } });
    };

    const result = JSON.parse(await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "sidebar", expression: "location.href" }));

    expect(opens).toEqual([{ projectPath: p.dir, browser: "chrome", surface: "sidebar", timeout: undefined }]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("evaluated");
    expect(result.value).toEqual({ result: "panel", opened: true });
    expect(result.warnings.join(" ")).toContain("value.result holds what the read answered");
  });

  it("518: names the extension's open pages beside the open's own reason when the panel is closed and does not open", async () => {
    const p = project();
    const other = `chrome-extension://${p.id}/sidebar/compact.html`;
    cdpTargets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/bg.js`, title: "" },
      { id: "tab", type: "page", url: "https://www.youtube.com/", title: "YouTube" },
      { id: "compact", type: "page", url: other, title: "Compact" },
    ];

    openReply = () =>
      JSON.stringify({
        ok: false,
        command: "extension_open",
        status: "gesture-required",
        error: { code: "E_USER_GESTURE_REQUIRED", name: "UserGestureRequired", message: "sidePanel.open needs a user gesture." },
        hint: "Retry with asTab: true to render the surface document in a tab instead.",
      });

    const result = JSON.parse(await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "sidebar", expression: "1" }));

    expect(opens).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("gesture-required");
    expect(result.error.code).toBe("E_USER_GESTURE_REQUIRED");
    expect(result.error.message).toContain(other);
    expect(result.error.message).not.toContain("youtube");
    expect(result.error.message).toContain("sidePanel.open needs a user gesture.");
    expect(result.value).toMatchObject({ opened: false, openExtensionPages: [{ targetId: "compact", url: other }] });
    expect(result.hint).toBe("Retry with asTab: true to render the surface document in a tab instead.");
  });

  it("says the extension has no page open at all when that is the case", async () => {
    const p = project();
    cdpTargets = [
      { id: "sw", type: "service_worker", url: `chrome-extension://${p.id}/bg.js`, title: "" },
      { id: "tab", type: "page", url: "https://www.youtube.com/", title: "YouTube" },
    ];

    const result = JSON.parse(await evalTool.handler({ projectPath: p.dir, browser: "chrome", context: "sidebar", expression: "1" }));

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("no page open at all");
    expect(result.value.openExtensionPages).toEqual([]);
    expect(String(result.hint ?? "")).not.toContain("setOptions");
  });
});
