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
    expect(result.value.warnings.find((w: string) => w.includes("ryd.script.js"))).toContain("web_accessible_resources");
    expect(result.value.warnings.find((w: string) => w.includes("images/*"))).toBeUndefined();
  });
});

describe("a manifest passed inline is validated without the files it names", () => {
  const INLINE = {
    ...BASE,
    default_locale: "en",
    action: { default_popup: "popup.html" },
    background: { service_worker: "sw.js" },
    permissions: ["storag"],
    web_accessible_resources: [{ resources: ["inject.js"], matches: ["<all_urls>"] }],
  };

  it("checks keys, permissions and browsers, names each skipped check, and reports no named file missing", async () => {
    for (const manifest of [INLINE, JSON.stringify(INLINE)]) {
      const out = JSON.parse(await manifestValidate.handler({ manifest, browsers: ["chrome", "firefox"] }));
      const lines = [...out.value.errors, ...out.value.warnings].join("\n");

      expect(out.value.skippedChecks).toEqual(["referencedFiles", "webAccessibleResourceFiles", "defaultLocaleCatalog", "sourceApiScan", "wasmSourceEvidence", "droppedRuntimePages"]);
      expect(out.value.warnings[0]).toMatch(/^Only the manifest was sent, so these checks that read the project's files were skipped: /);
      expect(lines).not.toMatch(/not found near the manifest|_locales\/en/);
      expect(lines).toContain('Unrecognized permission "storag"');
      expect(Object.keys(out.value.browserSupport)).toEqual(["chrome", "firefox"]);
      expect(lines).toContain("Firefox: no browser_specific_settings.gecko.id");
      expect(lines).not.toContain(os.tmpdir());
    }
  });

  it("refuses inline text that is not a JSON object, and a call that also names a path", async () => {
    for (const manifest of ["{ name: ", "[1]", "null"]) {
      expect(JSON.parse(await manifestValidate.handler({ manifest })), manifest).toMatchObject({ ok: false, status: "manifest-unreadable", error: { code: "E_BAD_MANIFEST" } });
    }

    const both = JSON.parse(await manifestValidate.handler({ manifest: INLINE, projectPath: project(BASE) }));

    expect(both).toMatchObject({ ok: false, status: "bad-request", error: { code: "E_BAD_REQUEST" } });
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
    const warnings: string[] = result.value.warnings;

    expect(result.value.browserSupport.firefox.supported).toBe(true);
    expect(warnings.find((w) => w.includes("gecko.id"))).toContain("new internal ID on every launch");
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

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"], include: ["storeReadiness"] }));

    expect(result.value.warnings.find((w: string) => w.includes("gecko.id"))).toBeUndefined();
    const declaration = result.value.storeReadiness.find((w: string) => w.includes("data_collection_permissions"));

    expect(declaration).toContain("ask the person and write the block");
    expect(declaration).toContain("with the categories they state");
    expect(declaration).toContain("https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/");
    expect(declaration).not.toMatch(/\bnone\b|"required"|transmits no data/i);
    expect(declaration).toContain("Do not add it on their behalf, and do not propose a value for it either. This rule is about the declaration alone.");
    expect(result.value.proposedGeckoId).toBeUndefined();
    expect(declaration).not.toContain("the minimal form is");

    const complete = project(
      {
        ...BASE,
        "firefox:browser_specific_settings": {
          gecko: { id: "f@example.com", data_collection_permissions: { required: ["none"] } },
        },
      },
      ["public/images/icon-16.png"],
    );
    const quiet = JSON.parse(await manifestValidate.handler({ projectPath: complete, browsers: ["firefox"], include: ["storeReadiness"] }));
    expect(quiet.value.storeReadiness.find((w: string) => w.includes("data_collection_permissions"))).toBeUndefined();
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
    const porting = result.value.warnings.find((w: string) => w.includes("stays on Manifest V2"));

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
    const all = [...result.value.warnings, ...result.value.errors].join("\n");

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

    expect(result.value.warnings.find((w: string) => w.includes("stays on Manifest V2"))).toBeUndefined();
  });

  it("still gives a Firefox-only background.scripts manifest the port advice", async () => {
    const mv2 = project(
      { ...BASE, "firefox:background": { scripts: ["bg.js"] } },
      ["public/images/icon-16.png", "src/bg.js"],
    );
    const mv2Result = JSON.parse(await manifestValidate.handler({ projectPath: mv2, browsers: ["firefox"] }));

    expect(mv2Result.value.warnings.find((w: string) => w.includes("stays on Manifest V2"))).toContain(
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

    expect(mv3Result.value.warnings.find((w: string) => w.includes("no service worker for Chromium"))).toContain(
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

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["chrome"], include: ["similarTemplates"] }));
    const slugs: string[] = result.value.similarTemplates.map((t: { slug: string }) => t.slug);

    expect(slugs[0]).toMatch(/^devtools/);
    expect(slugs.filter((s) => s.startsWith("devtools")).length).toBeGreaterThanOrEqual(3);
    expect(slugs.filter((s) => s.startsWith("ai-"))).toEqual([]);
  });

  it("answers similarTemplates only when include asks, and says each warning once (ledger 503)", async () => {
    const dir = project(
      { ...BASE, devtools_page: "devtools.html", "chromium:action": { default_popup: "popup.html" } },
      ["public/images/icon-16.png", "src/devtools.html", "src/popup.html"],
    );

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));

    expect(result.value.similarTemplates).toBeUndefined();
    expect(result.value.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result).split(JSON.stringify(result.value.warnings[0]))).toHaveLength(2);
  });
});

describe("928: a missing Firefox add-on ID is written now, with a value the answer proposes", () => {
  const FIREFOX_ID = /^[a-z0-9._-]*@[a-z0-9._-]+$/;

  async function answer(manifest: Record<string, unknown>, pkg?: Record<string, unknown>) {
    const dir = project({ ...BASE, ...manifest }, ["public/images/icon-16.png"]);

    if (pkg) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));

    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"], include: ["storeReadiness"] }));
    const warnings: string[] = result.value.warnings;

    return { result, warnings, store: result.value.storeReadiness as string[], line: warnings.find((w) => w.includes("no browser_specific_settings.gecko.id")) ?? "" };
  }

  it("says to write it now with the proposed value, that it is provisional and locks at the first submission, and to tell the owner", async () => {
    const { result, warnings, line } = await answer({ name: "Clip Shelf Pro" });

    expect(line).toBe(
      'Firefox: no browser_specific_settings.gecko.id. A temporary add-on without one gets a new internal ID on every launch, so storage and the moz-extension:// origin do not survive a relaunch, and a store upload needs the ID. Write it now as firefox:browser_specific_settings.gecko.id with the value "clip-shelf-pro@example.com" (the manifest name, at example.com because the project shows no domain of the owner\'s). It is provisional and locks at the first Firefox submission, so tell the owner you wrote it and that they can change it before then.',
    );

    expect(result.value.proposedGeckoId).toBe("clip-shelf-pro@example.com");
    expect(warnings.filter((w) => w.includes("no browser_specific_settings.gecko.id"))).toHaveLength(1);
  });

  it("the declaration rule comes first and names the declaration alone, so no sentence after the ID line takes its instruction back", async () => {
    const { warnings, store, line } = await answer({ name: "Clip Shelf" });
    const declaration = store.find((w) => w.includes("no browser_specific_settings.gecko.data_collection_permissions")) ?? "";

    expect(declaration).toMatch(/Do not add it on their behalf, and do not propose a value for it either\. This rule is about the declaration alone\.$/);
    expect(declaration).not.toMatch(/gecko\.id\b/);
    expect(warnings).toContain(line);
    expect(warnings.join("\n")).not.toContain("data_collection_permissions");
    expect(line).not.toMatch(/do not (add|propose|write)|on their behalf|ask the/i);
  });

  it.each([
    ["a name with spaces and accents", { name: "  Café  Tab_Tidy 2!  " }, undefined, "cafe-tab-tidy-2@example.com", "the manifest name, at example.com because the project shows no domain of the owner's"],
    ["a __MSG_ name, read from the package name without its scope", { name: "__MSG_extName__", default_locale: undefined }, { name: "@acme/tab-tidy" }, "tab-tidy@example.com", "the package name, at example.com"],
    ["a homepage_url host, without www", { name: "Clip Shelf", homepage_url: "https://www.clipshelf.app/docs" }, undefined, "clip-shelf@clipshelf.app", "the manifest name, at the host of the manifest's homepage_url"],
    ["a package homepage on a shared code host, passed over for the author URL", { name: "Clip Shelf" }, { name: "clip", homepage: "https://github.com/acme/clip#readme", author: "Jane Roe <jane@example.org> (https://jane.dev/about)" }, "clip-shelf@jane.dev", "the manifest name, at the host of the package author URL"],
    ["a package homepage of the owner's", { name: "Clip Shelf" }, { name: "clip", homepage: "https://clip.acme.io" }, "clip-shelf@clip.acme.io", "the manifest name, at the host of the package homepage"],
    ["a homepage_url that is no web address", { name: "Clip Shelf", homepage_url: "ftp://files.clipshelf.app/clip" }, undefined, "clip-shelf@example.com", "the manifest name, at example.com"],
  ])("builds the value from %s", async (_label, manifest, pkg, id, why) => {
    const { result, line } = await answer(manifest as Record<string, unknown>, pkg);

    expect(result.value.proposedGeckoId).toBe(id);
    expect(line).toContain(`with the value "${id}" (${why}`);
    expect(id).toMatch(FIREFOX_ID);
  });

  it("keeps an over-long name inside the 80 characters Firefox allows, without a dangling hyphen", async () => {
    const { result } = await answer({ name: "A very long extension name that keeps going ".repeat(4), homepage_url: "https://tools.acme-widgets.example.org" });
    const id: string = result.value.proposedGeckoId;

    expect(id).toMatch(FIREFOX_ID);
    expect(id.length).toBe(80);
    expect(id.endsWith("@tools.acme-widgets.example.org")).toBe(true);
    expect(id).not.toContain("-@");
  });

  it("names the unprefixed key when the manifest already holds an unprefixed block, and falls back to the folder name", async () => {
    const { result, line } = await answer({ name: "日本語", browser_specific_settings: { gecko: { strict_min_version: "128.0" } } });

    expect(line).toContain("Write it now as browser_specific_settings.gecko.id with the value");
    expect(result.value.proposedGeckoId).toMatch(/^mcp-validate-gecko-[a-z0-9-]+@example\.com$/);
    expect(line).toContain("(the project folder's name, at example.com");
  });
});

describe("data_collection_permissions follows what AMO's linter reports", () => {
  const withDataCollection = (bss: Record<string, unknown>) => ({
    ...BASE,
    "firefox:browser_specific_settings": { gecko: { id: "f@example.com", data_collection_permissions: { required: ["none"] }, ...(bss.gecko as object) }, ...(bss.gecko_android ? { gecko_android: bss.gecko_android } : {}) },
  });

  const report = async (bss: Record<string, unknown>) => {
    const dir = project(withDataCollection(bss), ["images/icon-16.png"]);

    return JSON.stringify(JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] })));
  };

  it("says nothing when no minimum is set, as the linter does", async () => {
    expect(await report({})).not.toMatch(/data_collection_permissions is read by|reads it from 142/);
  });

  it("warns when the minimum is below 140", async () => {
    expect(await report({ gecko: { strict_min_version: "128.0" } })).toMatch(/strict_min_version is \\"128\.0\\", so Mozilla's linter reports the key as unsupported/);
  });

  it("names the Android minimum at 140 and stays quiet once gecko_android sets 142", async () => {
    expect(await report({ gecko: { strict_min_version: "140.0" } })).toMatch(/Firefox for Android reads it from 142/);
    expect(await report({ gecko: { strict_min_version: "140.0" }, gecko_android: { strict_min_version: "142.0" } })).not.toMatch(/reads it from 142/);
  });
});

describe("admin_install_only names AMO's enterprise channel (ledger 511)", () => {
  const withKey = (value: unknown) => ({
    ...BASE,
    "firefox:browser_specific_settings": { gecko: { id: "f@example.com", data_collection_permissions: { required: ["none"] }, admin_install_only: value } },
  });

  it("says a true key sends the version to the enterprise channel from December 1, 2026, neither listed nor unlisted, and blocks nothing", async () => {
    const dir = project(withKey(true), ["images/icon-16.png"]);
    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));
    const line = result.value.warnings.find((w: string) => w.includes("admin_install_only"));

    expect(result.status).toBe("valid");
    expect(line).toContain("from December 1, 2026");
    expect(line).toContain("enterprise channel");
    expect(line).toContain("neither listed nor unlisted");
    expect(line).toContain("accept the updated Firefox Add-on Distribution Agreement");
    expect(line).toContain("https://blog.mozilla.org/addons/2026/10/28/introducing-enterprise-add-on-policies/");
    expect(result.value.warnings.filter((w: string) => w.includes("admin_install_only"))).toHaveLength(1);
  });

  it("refuses a value that is not a boolean for the Firefox build, as AMO's linter does", async () => {
    const dir = project(withKey("yes"), ["images/icon-16.png"]);
    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));

    expect(result.status).toBe("invalid");
    expect(result.value.buildBlocking).toBe(true);
    expect(result.value.errors.join("\n")).toMatch(/admin_install_only must be true or false, got "yes"/);
    expect(result.value.warnings.find((w: string) => w.includes("enterprise channel"))).toBeUndefined();
  });

  it("warns that a false key is still refused by AMO's linter outside the enterprise channel", async () => {
    const dir = project(withKey(false), ["images/icon-16.png"]);
    const result = JSON.parse(await manifestValidate.handler({ projectPath: dir, browsers: ["firefox"] }));

    expect(result.status).toBe("valid");
    expect(result.value.warnings.find((w: string) => w.includes("admin_install_only"))).toContain("ADMIN_INSTALL_ONLY_PROP_RESERVED");
  });
});
