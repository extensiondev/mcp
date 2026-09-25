import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelope } from "../lib/envelope";

const calls: string[][] = [];
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/act")>();
  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);
      return envelope({
        ok: true,
        command: "extension_eval",
        status: "ok",
        value: { __extensionDevRelay: 1, done: true, ok: true, value: "panel" },
      });
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => null };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];
function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gecko-url-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

const MANIFEST = {
  manifest_version: 2,
  name: "F",
  sidebar_action: { default_panel: "sidebar/index.html" },
  chrome_url_overrides: { newtab: "newtab/index.html" },
};

afterEach(() => {
  calls.length = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function contextOf(cli: string[]): string {
  return cli[cli.indexOf("--context") + 1];
}

describe("extension_eval on Gecko maps a moz-extension:// url in context page to its surface", () => {
  it("runs a sidebar document url through the sidebar relay and says so", async () => {
    const dir = project(MANIFEST);

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "moz-extension://5f2a6f1e-0000-4000-8000-000000000000/sidebar/index.html",
        expression: "document.title",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("panel");
    expect(calls).toHaveLength(1);
    expect(contextOf(calls[0])).toBe("sidebar");
    expect(calls[0]).not.toContain("--url");
    expect(result.warnings[0]).toContain('context: "sidebar"');
    expect(JSON.stringify(result)).not.toMatch(/chrome\.scripting/);
  });

  it("names the declared surfaces when the extension url is none of them", async () => {
    const dir = project(MANIFEST);

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "firefox",
        context: "page",
        url: "moz-extension://5f2a6f1e-0000-4000-8000-000000000000/pages/welcome.html",
        expression: "1",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_SURFACE_DOCUMENT");
    expect(result.error.message).toContain("sidebar, newtab");
    expect(result.hint).toContain('context: "sidebar"');
    expect(calls).toEqual([]);
  });

  it("leaves a web url in context page on the page path", async () => {
    const dir = project(MANIFEST);

    await evalTool.handler({
      projectPath: dir,
      browser: "firefox",
      context: "page",
      url: "https://example.com/",
      expression: "1",
    });

    expect(calls).toHaveLength(1);
    expect(contextOf(calls[0])).toBe("page");
    expect(calls[0]).toContain("--url");
  });
});
