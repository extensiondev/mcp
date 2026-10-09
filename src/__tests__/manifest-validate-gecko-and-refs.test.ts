import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import snapshot from "../lib/templates-meta.snapshot.json";

import type * as TemplatesCacheModule from "../lib/templates-cache";

vi.mock("../lib/templates-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof TemplatesCacheModule>();

  return {
    ...actual,
    listTemplates: async () =>
      (snapshot as { templates: Array<{ slug: string; surfaces: string[] }> }).templates.map((t) => ({
        slug: t.slug,
        surfaces: t.surfaces ?? [],
      })),
  };
});

const manifestValidate = await import("../tools/manifest-validate");

const dirs: string[] = [];

function project(manifest: Record<string, unknown>, files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-validate-gecko-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));

  for (const rel of files) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "");
  }

  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BASE = {
  "chromium:manifest_version": 3,
  "firefox:manifest_version": 2,
  name: "F",
  version: "1.0.0",
  icons: { "16": "images/icon-16.png" },
};

describe("extension_manifest_validate reads the tree the engine builds from", () => {
  it("resolves an icon shipped from public/ instead of calling it dangling", async () => {
    const dir = project(BASE, ["public/images/icon-16.png"]);

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }));

    expect(result.value.errors.filter((e: string) => e.includes("icon-16.png"))).toEqual([]);
  });

  it("warns, without blocking, about a web-accessible resource the tree lacks", async () => {
    const dir = project(
      {
        ...BASE,
        web_accessible_resources: [{ resources: ["ryd.script.js", "images/*"], matches: ["<all_urls>"] }],
      },
      ["public/images/icon-16.png"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }));

    expect(result.value.buildBlocking).toBe(false);
    expect(result.warnings.find((w: string) => w.includes("ryd.script.js"))).toContain("web_accessible_resources");
    expect(result.warnings.find((w: string) => w.includes("images/*"))).toBeUndefined();
  });
});

describe("the Firefox report names what Firefox itself would say", () => {
  it("warns on a missing gecko id and on Chromium-only keys, and does not block Firefox over a Chromium side panel", async () => {
    const dir = project(
      {
        ...BASE,
        version_name: "1.0 beta",
        "chromium:side_panel": { default_path: "sidebar/index.html" },
        web_accessible_resources: [{ resources: ["a.js"], matches: ["<all_urls>"], extension_ids: ["abc"] }],
        background: { "chromium:service_worker": "bg.js", "firefox:scripts": ["bg.js"] },
      },
      ["public/images/icon-16.png", "src/sidebar/index.html", "src/bg.js", "src/a.js"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const warnings: string[] = result.warnings;

    expect(result.value.browserSupport.firefox.supported).toBe(true);
    expect(warnings.find((w) => w.includes("gecko.id"))).toContain("new internal id on every launch");
    expect(warnings.find((w) => w.includes('"version_name"'))).toContain("Chromium-only");
    expect(warnings.find((w) => w.includes("extension_ids"))).toBeDefined();
    expect(warnings.find((w) => w.includes("chromium:side_panel is declared and no firefox:sidebar_action"))).toBeDefined();
  });

  it("is quiet about the gecko id when the manifest sets it, and asks for data_collection_permissions until it is there", async () => {
    const dir = project(
      {
        ...BASE,
        "firefox:browser_specific_settings": { gecko: { id: "f@example.com" } },
      },
      ["public/images/icon-16.png"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));

    expect(result.warnings.find((w: string) => w.includes("gecko.id"))).toBeUndefined();
    expect(result.warnings.find((w: string) => w.includes("data_collection_permissions"))).toContain('{"required": ["none"]}');

    const complete = project(
      {
        ...BASE,
        "firefox:browser_specific_settings": {
          gecko: { id: "f@example.com", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } },
        },
      },
      ["public/images/icon-16.png"],
    );
    const quiet = JSON.parse(await manifestValidate.handler({ projectPath: complete, browsers: ["firefox"] }));
    expect(quiet.warnings.find((w: string) => w.includes("data_collection_permissions"))).toBeUndefined();
  });

  it("gives an MV2 Firefox manifest the keys to port for Chromium", async () => {
    const dir = project(
      {
        manifest_version: 2,
        name: "floccus",
        version: "5.0.0",
        background: { scripts: ["bg.js"] },
        browser_action: { default_title: "x" },
        permissions: ["storage", "*://*/*", "webRequestBlocking"],
        web_accessible_resources: ["page.html"],
      },
      ["src/bg.js", "src/page.html"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const porting = result.warnings.find((w: string) => w.includes("stays on Manifest V2"));

    expect(porting).toContain("chromium:service_worker");
    expect(porting).toContain("chromium:action");
    expect(porting).toContain("host_permissions");
    expect(porting).toContain("declarativeNetRequest");
    expect(porting).toContain("[{resources, matches}]");
  });

  it("never tells the newtab-react manifest to port the background it already prefixes", async () => {
    const dir = project(
      {
        $schema: "https://json.schemastore.org/chrome-manifest.json",
        "chromium:manifest_version": 3,
        "firefox:manifest_version": 2,
        version: "1.0.0",
        "firefox:browser_specific_settings": {
          gecko: { id: "newtab-react@extension.js", data_collection_permissions: { required: ["none"] } },
        },
        name: "React New Tab Example",
        description: "Replaces your new tab page with a simple React page.",
        icons: { "16": "images/icon-16.png" },
        background: { "chromium:service_worker": "background.js", "firefox:scripts": ["background.js"] },
        chrome_url_overrides: { newtab: "newtab/index.html" },
      },
      ["public/images/icon-16.png", "src/background.js", "src/newtab/index.html"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const all = [...result.warnings, ...result.value.errors].join("\n");

    expect(all).not.toContain("background.scripts to a single chromium:service_worker");
    expect(all).not.toContain("no service worker for Chromium");
  });

  it("reads a service worker and action prefixed at the top level too", async () => {
    const dir = project(
      {
        ...BASE,
        "chromium:background": { service_worker: "bg.js" },
        "firefox:background": { scripts: ["bg.js"] },
        "chromium:action": { default_title: "x" },
        "firefox:browser_action": { default_title: "x" },
      },
      ["public/images/icon-16.png", "src/bg.js"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));

    expect(result.warnings.find((w: string) => w.includes("stays on Manifest V2"))).toBeUndefined();
  });

  it("still gives a Firefox-only background.scripts manifest the port advice", async () => {
    const mv2 = project(
      { ...BASE, "firefox:background": { scripts: ["bg.js"] } },
      ["public/images/icon-16.png", "src/bg.js"],
    );
    const mv2Result = JSON.parse(await manifestValidate.handler({ projectPath: mv2, browsers: ["firefox"] }));

    expect(mv2Result.warnings.find((w: string) => w.includes("stays on Manifest V2"))).toContain(
      "background.scripts to a single chromium:service_worker",
    );

    const mv3 = project(
      {
        manifest_version: 3,
        name: "F",
        version: "1.0.0",
        icons: { "16": "images/icon-16.png" },
        background: { scripts: ["bg.js"] },
      },
      ["public/images/icon-16.png", "src/bg.js"],
    );
    const mv3Result = JSON.parse(await manifestValidate.handler({ projectPath: mv3, browsers: ["firefox"] }));

    expect(mv3Result.warnings.find((w: string) => w.includes("no service worker for Chromium"))).toContain(
      "chromium:service_worker",
    );
  });
});

describe("template similarity counts every surface the manifest declares", () => {
  it("ranks devtools templates for a devtools_page extension", async () => {
    const dir = project(
      { ...BASE, devtools_page: "devtools.html", "chromium:action": { default_popup: "popup.html" } },
      ["public/images/icon-16.png", "src/devtools.html", "src/popup.html"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"] }));
    const slugs: string[] = result.value.similarTemplates.map((t: { slug: string }) => t.slug);

    expect(slugs[0]).toMatch(/^devtools/);
    expect(slugs.filter((s) => s.startsWith("devtools")).length).toBeGreaterThanOrEqual(3);
    expect(slugs.filter((s) => s.startsWith("ai-"))).toEqual([]);
  });
});

describe("data_collection_permissions names the Firefox version that reads it", () => {
  const withDataCollection = (gecko: Record<string, unknown>) => ({
    ...BASE,
    "firefox:browser_specific_settings": { gecko: { id: "f@example.com", data_collection_permissions: { required: ["none"] }, ...gecko } },
  });

  it("warns when no strict_min_version reaches 140", async () => {
    const dir = project(withDataCollection({}), ["images/icon-16.png"]);
    const out = JSON.stringify(JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] })));
    expect(out).toMatch(/data_collection_permissions is read by Firefox 140 and later/);
  });

  it("stays quiet once strict_min_version is 140 or later", async () => {
    const dir = project(withDataCollection({ strict_min_version: "140.0" }), ["images/icon-16.png"]);
    const out = JSON.stringify(JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] })));
    expect(out).not.toMatch(/data_collection_permissions is read by Firefox 140/);
  });
});
