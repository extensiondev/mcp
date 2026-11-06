import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readyContract } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return { ...actual, runActVerb: async () => JSON.stringify({ ok: false, error: { message: "not used" } }) };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return { ...actual, resolveCdpPort: async () => ({ port: 9222, source: "contract" as const }) };
});

let cdpTargets: Array<{ id: string; type: string; url: string; title?: string }> = [];
const navigations: Array<{ id: string; url: string }> = [];
const created: string[] = [];

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
      return `session-${id}`;
    }
    async enableDomains() {}
    async navigate(sessionId: string, url: string) {
      const id = sessionId.replace(/^session-/, "");
      navigations.push({ id, url });
      cdpTargets = cdpTargets.map((t) => (t.id === id ? { ...t, url, title: "Reloaded" } : t));
    }
    async evaluate() {
      return null;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Target.createTarget") {
        const id = `created-${created.length + 1}`;
        created.push(String(params?.url ?? ""));
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

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-open-reuse-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F" }));
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(path.join(readyDir, "ready.json"), JSON.stringify(readyContract("dev", "chrome", { distPath: path.join(dir, "dist", "chrome") })));

  return dir;
}

const SITE = "http://127.0.0.1:4322/";

afterEach(() => {
  cdpTargets = [];
  navigations.length = 0;
  created.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("433: extension_open reloads a tab that already shows the url instead of opening another", () => {
  it("navigates the existing tab in place and answers reused: true with the same targetId", async () => {
    cdpTargets = [
      { id: "other", type: "page", url: "https://example.com/" },
      { id: "site", type: "page", url: SITE, title: "Site" },
    ];

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SITE }));

    expect(result.ok).toBe(true);
    expect(result.value.reused).toBe(true);
    expect(result.value.openedNewTab).toBeUndefined();
    expect(result.value.target.targetId).toBe("site");
    expect(navigations).toEqual([{ id: "site", url: SITE }]);
    expect(created).toEqual([]);
    expect(cdpTargets.filter((t) => t.url === SITE)).toHaveLength(1);
  });

  it("treats a hash as the same document, and keeps the tab count at one across repeated calls", async () => {
    cdpTargets = [{ id: "site", type: "page", url: `${SITE}#top` }];
    const dir = project();

    const first = JSON.parse(await open.handler({ projectPath: dir, url: SITE }));
    const second = JSON.parse(await open.handler({ projectPath: dir, url: SITE }));

    expect(first.value.reused).toBe(true);
    expect(second.value.reused).toBe(true);
    expect(second.value.target.targetId).toBe("site");
    expect(cdpTargets).toHaveLength(1);
  });

  it("opens a second tab only when newTab: true says so", async () => {
    cdpTargets = [{ id: "site", type: "page", url: SITE }];

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SITE, newTab: true }));

    expect(result.value.openedNewTab).toBe(true);
    expect(result.value.reused).toBeUndefined();
    expect(result.value.target.targetId).toBe("created-1");
    expect(cdpTargets.filter((t) => t.url === SITE)).toHaveLength(2);
  });

  it("still opens a new tab for a url no tab shows, and never takes over a tab on another url", async () => {
    cdpTargets = [{ id: "other", type: "page", url: "https://example.com/" }];

    const result = JSON.parse(await open.handler({ projectPath: project(), url: SITE }));

    expect(result.value.openedNewTab).toBe(true);
    expect(cdpTargets.map((t) => t.url)).toEqual(["https://example.com/", SITE]);
  });

  it("names the reuse rule and the newTab switch in the schema", () => {
    expect(open.schema.description).toContain("a tab already showing the url is reloaded in place (reused: true) unless newTab: true");
    expect(open.schema.inputSchema.properties.newTab.description).toContain("reloaded in place");
  });
});
