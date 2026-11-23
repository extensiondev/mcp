
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as TemplatesCacheModule from "../lib/templates-cache";
import { DEFAULT_SERVER_OPTIONS, setServerOptions } from "../lib/tool-policy";

vi.mock("../lib/templates-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof TemplatesCacheModule>();

  return { ...actual, listTemplates: async () => [] };
});

const manifestValidate = await import("../tools/manifest-validate");

const dirs: string[] = [];

function project(manifest: Record<string, unknown>, files: string[] = [], where: "src" | "root" = "src"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-validate-browsers-"));
  dirs.push(dir);
  const manifestDir = where === "src" ? path.join(dir, "src") : dir;
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify(manifest));

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

const validate = (projectPath: string, browsers?: string[]) =>
  manifestValidate.handler({ projectPath, ...(browsers ? { browsers } : {}) }).then((s) => JSON.parse(s));

describe("references are checked in each requested browser's view", () => {
  const BASE = { "chromium:manifest_version": 3, "firefox:manifest_version": 2, name: "F", version: "1.0.0" };

  it("blocks a Firefox-only validation on a missing firefox: panel", async () => {
    const dir = project({ ...BASE, "firefox:sidebar_action": { default_panel: "sidebar/missing.html" } });
    const out = await validate(dir, ["firefox"]);
    expect(out.status).toBe("invalid");
    expect(out.value.errors.join("\n")).toMatch(/sidebar\/missing\.html.*firefox view/);
  });

  it("blocks a Firefox-only validation on a missing firefox: background script", async () => {
    const dir = project({ ...BASE, "firefox:background": { scripts: ["missing-bg.js"] } });
    const out = await validate(dir, ["firefox"]);
    expect(out.status).toBe("invalid");
    expect(out.value.errors.join("\n")).toMatch(/missing-bg\.js/);
  });

  it("reads admin_install_only in the firefox view only, so a chrome validation passes what the firefox one refuses (ledger 511)", async () => {
    const dir = project({ ...BASE, "firefox:browser_specific_settings": { gecko: { id: "f@example.com", admin_install_only: "yes" } } });
    const chrome = await validate(dir, ["chrome"]);
    const firefox = await validate(dir, ["firefox"]);

    expect(chrome.status).toBe("valid");
    expect(JSON.stringify(chrome)).not.toContain("admin_install_only");
    expect(firefox.status).toBe("invalid");
    expect(firefox.value.errors.join("\n")).toMatch(/firefox: .*admin_install_only must be true or false/);
  });

  it("does not block a Firefox-only validation on a missing chromium:-only file", async () => {
    const dir = project({ ...BASE, "chromium:side_panel": { default_path: "panel/missing.html" } });
    const out = await validate(dir, ["firefox"]);
    expect(out.status).toBe("valid");
    const chrome = await validate(dir, ["chrome"]);
    expect(chrome.status).toBe("invalid");
    expect(chrome.value.errors.join("\n")).toMatch(/panel\/missing\.html.*chrome view/);
  });
});

describe("an unknown browser is refused, an empty list is the default list", () => {
  const MV3 = { manifest_version: 3, name: "x", version: "1.0.0" };

  it("refuses a capitalised or misspelled target instead of passing it unchecked", async () => {
    const dir = project(MV3);
    const out = await validate(dir, ["Chrome"]);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("unknown-browser");
    expect(out.error.message).toMatch(/did you mean "chrome"/);
    expect(out.value.browserSupport).toEqual({});
  });

  it("checks the default targets for browsers: []", async () => {
    const dir = project(MV3);
    const out = await validate(dir, []);
    expect(Object.keys(out.value.browserSupport).sort()).toEqual(["chrome", "edge", "firefox"]);
  });

  it("says safari is checked as its Chromium source only", async () => {
    const dir = project(MV3);
    const out = await validate(dir, ["safari"]);
    expect(out.value.warnings.join("\n")).toMatch(/safari: checked as its Chromium source manifest/);
  });
});

describe("the default build target's issues stay blocking", () => {
  it("answers invalid for a chrome issue when no browsers were passed, as the chrome build would", async () => {
    const dir = project(
      { manifest_version: 3, name: "x", version: "1.0.0", side_panel: { default_path: "panel.html" } },
      ["src/panel.html"],
    );
    const implicit = await validate(dir);
    const explicit = await validate(dir, ["chrome"]);
    expect(explicit.status).toBe("invalid");
    expect(implicit.status).toBe("invalid");
    expect(implicit.value.buildBlocking).toBe(true);
    expect(implicit.value.errors.join("\n")).toMatch(/chrome \(the default build target\).*sidePanel/);
  });
});

describe("the permission scan reaches src/ first and says when it stopped", () => {
  it("finds the crash-level API under src/ past 301 files that sort before it, and reports the cap", async () => {
    const dir = project(
      { manifest_version: 3, name: "x", version: "1.0.0" },
      [...Array.from({ length: 301 }, (_, i) => `a/f${String(i).padStart(3, "0")}.js`)],
      "root",
    );
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "x.js"), "chrome.history.search({});");
    const out = await validate(dir, ["chrome"]);
    expect(out.value.warnings.join("\n")).toMatch(/chrome\.history/);
    expect(out.value.warnings.join("\n")).toMatch(/stopped at its cap/);
  });

  it("reports a source file it could not read", async () => {
    const dir = project({ manifest_version: 3, name: "x", version: "1.0.0" }, ["src/ok.js"]);
    fs.symlinkSync("/nowhere/at/all.js", path.join(dir, "src", "gone.js"));
    const out = await validate(dir, ["chrome"]);
    expect(out.value.warnings.join("\n")).toMatch(/could not be read.*gone\.js/);
  });
});

describe("a permission gap names the key that holds the grant and the key this target reads", () => {
  const BASE = {
    "chromium:manifest_version": 3,
    "firefox:manifest_version": 2,
    name: "G",
    version: "1.0.0",
    background: { "chromium:service_worker": "background.js", "firefox:scripts": ["background.js"] },
  };

  const withCall = (manifest: Record<string, unknown>): string => {
    const dir = project(manifest);
    fs.writeFileSync(path.join(dir, "src", "background.js"), 'chrome.storage.local.get("a");');

    return dir;
  };

  it("says chromium:permissions replaced the unprefixed permissions that list the grant, and to add it there", async () => {
    const dir = withCall({ ...BASE, permissions: ["storage"], "chromium:permissions": ["sidePanel"] });
    const out = await validate(dir, ["chrome", "firefox"]);
    const issue = out.value.browserSupport.chrome.issues.join("\n");

    expect(issue).toContain('"permissions" lists it, but "chromium:permissions" replaces "permissions" for chrome and does not list it');
    expect(issue).toContain('add "storage" to "chromium:permissions"');
    expect(issue).not.toContain("declared only under another target's prefixed key");
    expect(out.value.browserSupport.firefox.issues).toEqual([]);
  });

  it("says a browser prefix on a permission item belongs on the key, and keeps the typo line for any other unknown name", async () => {
    const dir = project({ ...BASE, permissions: ["storage", "chromium:sidePanel", "sidePanle"] });
    const out = await validate(dir, ["chrome"]);
    const warnings = out.value.warnings.join("\n");

    expect(warnings).toContain('"chromium:sidePanel" in permissions is not a permission name: a browser prefix goes on the key, not on an item. Write "chromium:permissions": ["sidePanel"]');
    expect(warnings).not.toContain('Unrecognized permission "chromium:sidePanel"');
    expect(warnings).toContain('Unrecognized permission "sidePanle", check for a typo');
  });

  it("names the other target's prefixed key when that is the only place the grant is declared", async () => {
    const dir = withCall({ ...BASE, "firefox:permissions": ["storage"], "chromium:permissions": ["sidePanel"] });
    const out = await validate(dir, ["chrome", "firefox"]);
    const issue = out.value.browserSupport.chrome.issues.join("\n");

    expect(issue).toContain('it is declared only under "firefox:permissions", which chrome does not read');
    expect(issue).toContain('add "storage" to "chromium:permissions"');
  });

  it("points at the unprefixed permissions when this target has no prefixed key of its own", async () => {
    const dir = withCall({ ...BASE, "firefox:permissions": ["storage"] });
    const out = await validate(dir, ["chrome", "firefox"]);
    const issue = out.value.browserSupport.chrome.issues.join("\n");

    expect(issue).toContain('it is declared only under "firefox:permissions", which chrome does not read');
    expect(issue).toContain('add "storage" to "permissions"');
  });
});

describe("822: a manifest key the Chromium family refuses to load is an error with its key paths, in the platform preflight's words", () => {
  const REFUSED = {
    manifest_version: 3,
    name: "Refused",
    version: "1.0.0",
    options_ui: { page: "options.html", chrome_style: false },
    icons: { 16: "icon.png", any: "icon.svg" },
    action: { default_icon: { "16.5": "icon.png", 32: "icon.png" } },
  };
  const FILES = ["src/options.html", "src/icon.png", "src/icon.svg"];
  const KEYS = ["options_ui.chrome_style", "icons.any", "action.default_icon.16.5"];
  const REASONS =
    'options_ui.chrome_style is set to false, and Chromium answers "The chrome_style option cannot be used with manifest version 3." for any value, false included; delete the key; ' +
    'icons has the key "any", and Chromium answers "Invalid key in icons" for a key that is not a whole pixel size from 1 to 2048; keep sizes such as "16", "48" and "128" and move anything else out of icons; ' +
    'action.default_icon has the key "16.5", and Chromium refuses the extension over an icon key that is not a whole pixel size from 1 to 2048; keep sizes such as "16" and "32" there';

  it.each([
    ["chrome", "Chrome"],
    ["edge", "Microsoft Edge"],
    ["brave", "Chromium"],
  ])("names the refused keys for %s", async (browser, name) => {
    const out = await validate(project(REFUSED, FILES), [browser]);
    const sentence = `${name} refuses to load this manifest, so nobody can install the extension: ${REASONS}. Other browsers ignore these keys, which is why the build is green. Fix the manifest and validate again.`;

    expect(out).toMatchObject({ ok: false, status: "invalid", error: { code: "E_BAD_MANIFEST" } });
    expect(out.value.refusedKeys).toEqual(KEYS);
    expect(out.value.browserSupport[browser]).toEqual({ supported: false, issues: [sentence], refusedKeys: KEYS });
    expect(out.value.errors).toEqual([`${browser}: ${sentence}`]);
    expect(out.value.buildBlocking).toBe(true);
    expect(out.error.hint).toBe(
      `Fix each line of value.errors in the manifest (the Chromium family refuses to load ${KEYS.join(", ")}), then call extension_manifest_validate again; extension_build refuses the same errors.`,
    );
  });

  it("says nothing for Firefox, which ignores the keys, and nothing for a manifest that carries none", async () => {
    const firefox = await validate(project({ ...REFUSED, browser_specific_settings: { gecko: { id: "refused@example.com" } } }, FILES), ["firefox"]);

    expect(firefox.value.refusedKeys).toBeUndefined();
    expect(firefox.value.browserSupport.firefox.refusedKeys).toBeUndefined();
    expect(JSON.stringify(firefox)).not.toContain("refuses to load");

    const clean = await validate(project({ ...REFUSED, options_ui: { page: "options.html" }, icons: { 16: "icon.png" }, action: { default_icon: "icon.png" } }, FILES), ["chrome"]);

    expect(clean.status).toBe("valid");
    expect(clean.value.refusedKeys).toBeUndefined();
    expect(clean.value.browserSupport.chrome).toEqual({ supported: true, issues: [] });
  });

  it("reads each browser's own view, so a key kept under firefox: is not refused for chrome", async () => {
    const out = await validate(project({ manifest_version: 3, name: "Views", version: "1.0.0", "firefox:icons": { any: "icon.svg" }, "chromium:icons": { 16: "icon.png" } }, FILES), ["chrome"]);

    expect(out.value.refusedKeys).toBeUndefined();
  });
});

describe("924: a theme Chromium cannot load is a Chromium issue, and a theme manifest is sent to extension_theme_verify", () => {
  const HEX = { frame: "#1b263b", toolbar: "#415a77", tab_background_text: "#e0e1dd", ntp_background: "#0d1b2a", ntp_text: "#e0e1dd" };
  const ARRAYS = { frame: [27, 38, 59], toolbar: [65, 90, 119], tab_background_text: [224, 225, 221], ntp_background: [13, 27, 42], ntp_text: [224, 225, 221] };
  const THEME = { manifest_version: 3, name: "harbor-dusk", version: "1.0.0", browser_specific_settings: { gecko: { id: "harbor-dusk@example.com" } } };

  afterEach(() => setServerOptions(DEFAULT_SERVER_OPTIONS));

  it("refuses hex colors for chrome with the array to write for each key, and keeps them for firefox", async () => {
    const out = await validate(project({ ...THEME, theme: { colors: HEX } }), ["chrome", "firefox"]);
    const issue = out.value.browserSupport.chrome.issues.join("\n");

    expect(out.status).toBe("invalid");
    expect(out.ok).toBe(false);
    expect(out.value.browserSupport.chrome.supported).toBe(false);
    expect(out.value.browserSupport.firefox).toEqual({ supported: true, issues: [] });
    expect(issue).toContain('Chromium refuses to load this theme ("Invalid value for theme colors - colors must be integers")');
    expect(issue).toContain("theme.colors.frame as [27, 38, 59], theme.colors.toolbar as [65, 90, 119], theme.colors.tab_background_text as [224, 225, 221], theme.colors.ntp_background as [13, 27, 42] and theme.colors.ntp_text as [224, 225, 221]");
    expect(issue).toContain('Firefox reads the same arrays, so one manifest serves both, and CSS color strings kept for Firefox go under "firefox:theme" with the arrays under "chromium:theme"');
    expect(out.value.errors).toEqual([`chrome: ${issue}`]);
    expect(out.value.buildBlocking).toBe(true);
    expect(out.error.hint).toContain("extension_theme_verify");
  });

  it("answers valid for arrays, and for hex under firefox:theme beside arrays under chromium:theme", async () => {
    const arrays = await validate(project({ ...THEME, theme: { colors: ARRAYS } }), ["chrome", "firefox"]);
    const prefixed = await validate(project({ ...THEME, "chromium:theme": { colors: ARRAYS }, "firefox:theme": { colors: HEX } }), ["chrome", "firefox"]);

    for (const out of [arrays, prefixed]) {
      expect(out.status).toBe("valid");
      expect(out.value.browserSupport.chrome).toEqual({ supported: true, issues: [] });
      expect(out.value.browserSupport.firefox).toEqual({ supported: true, issues: [] });
    }
  });

  it("writes the array for short hex, hex with alpha and rgb(), and asks for the values of a named color", async () => {
    const out = await validate(project({ ...THEME, theme: { colors: { frame: "#fff", toolbar: "#41 5a77", ntp_text: "#e0e1dd80", ntp_link: "rgb(1, 2, 3)", ntp_header: "navy" } } }), ["chrome"]);
    const issue = out.value.browserSupport.chrome.issues.join("\n");

    expect(issue).toContain("theme.colors.frame as [255, 255, 255]");
    expect(issue).toContain("theme.colors.toolbar as its [r, g, b] values");
    expect(issue).toContain("theme.colors.ntp_text as [224, 225, 221, 0.5]");
    expect(issue).toContain("theme.colors.ntp_link as [1, 2, 3]");
    expect(issue).toContain("theme.colors.ntp_header as its [r, g, b] values");
  });

  it("refuses a tint that is not three numbers, in Chromium's own words", async () => {
    const out = await validate(project({ ...THEME, theme: { colors: ARRAYS, tints: { buttons: "#fff", frame: [0.5, 0.5, 0.5] } } }), ["chrome"]);
    const issue = out.value.browserSupport.chrome.issues.join("\n");

    expect(out.status).toBe("invalid");
    expect(issue).toContain('"Invalid value for theme images - tints must be decimal numbers."');
    expect(issue).toContain("write theme.tints.buttons that way");
    expect(issue).not.toContain("theme.tints.frame");
  });

  it("names extension_theme_verify as the next step of a theme manifest, with the group to add while it is not listed", async () => {
    const dir = project({ ...THEME, theme: { colors: ARRAYS } });
    const unlisted = await validate(dir, ["chrome"]);

    setServerOptions({ features: ["local", "extras"], noShip: false });
    const listed = await validate(dir, ["chrome"]);
    const extension = await validate(project({ ...THEME }), ["chrome"]);

    expect(unlisted.hint).toBe(`This is a theme manifest: extension_theme_verify with manifestPath "${fs.realpathSync(path.join(dir, "src", "manifest.json"))}" reads the colors Chromium paints from it and the keys it drops; it is in the extras feature group, so add extras to --features in this server's MCP config, or ask the user to, then call it.`.replace(fs.realpathSync(dir), dir));
    expect(unlisted.hint).toContain("add extras to --features");
    expect(listed.hint).toMatch(/keys it drops; call it next\.$/);
    expect(listed.hint).not.toContain("--features");
    expect(extension.hint).toBeUndefined();
  });

  it("does not ask a static theme for the Firefox data collection declaration, which AMO's linter asks of an extension only", async () => {
    const theme = await validate(project({ ...THEME, theme: { colors: ARRAYS } }), ["firefox"]);
    const extension = await validate(project({ ...THEME }), ["firefox"]);

    expect(theme.value.warnings.join("\n")).not.toContain("data_collection_permissions");
    expect(extension.value.warnings.join("\n")).toContain("no browser_specific_settings.gecko.data_collection_permissions");
  });
});

describe("934: a project that loads WebAssembly is told about the 'wasm-unsafe-eval' grant", () => {
  const MV3 = { manifest_version: 3, name: "W", version: "1.0.0", background: { service_worker: "background.js" } };
  const POLICY = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
  const wasmLines = (out: { value: { warnings: string[] } }) => out.value.warnings.filter((w) => w.includes("wasm-unsafe-eval"));

  function put(dir: string, rel: string, body: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }

  it("names the import, the three places that cannot compile it and the exact policy value, and stays valid", async () => {
    const dir = project(MV3, ["src/background.js"]);
    put(dir, "src/background.js", 'import initSqlJs from "sql.js/dist/sql-wasm-browser.js";\ninitSqlJs({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/$' + '{file}` });\n');

    const out = await validate(dir);
    const lines = wasmLines(out);

    expect(out.status).toBe("valid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^WebAssembly: src\/background\.js imports sql\.js\/dist\/sql-wasm-browser\.js, and the chrome, firefox, edge manifest has no 'wasm-unsafe-eval' in content_security_policy\.extension_pages/);
    expect(lines[0]).toContain("extension pages and the background service worker or script cannot compile it");
    expect(lines[0]).toContain(`"content_security_policy": { "extension_pages": "${POLICY}" }`);
    expect(lines[0]).toContain("A content script compiles under the host page's policy, which this grant does not change.");
  });

  it("names a .wasm under public/ and the installed dependency that ships one", async () => {
    const dir = project(MV3, ["src/background.js", "public/vendor/zstd.wasm", "node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm", "node_modules/left-pad/index.js"]);
    put(dir, "package.json", JSON.stringify({ dependencies: { "@bokuweb/zstd-wasm": "0.0.27", "left-pad": "1.3.0" } }));

    const lines = wasmLines(await validate(dir, ["chrome"]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the project holds public/vendor/zstd.wasm");
    expect(lines[0]).toContain("the dependency @bokuweb/zstd-wasm ships dist/web/zstd.wasm");
    expect(lines[0]).not.toContain("left-pad");
  });

  it("says nothing when the view carries the grant, under a plain key or a browser prefix, and nothing when no WebAssembly is in sight", async () => {
    const source = 'const module = await WebAssembly.instantiateStreaming(fetch(new URL("add.wasm", import.meta.url)));\n';
    const granted = project({ ...MV3, content_security_policy: { extension_pages: POLICY } }, ["src/background.js"]);
    const prefixed = project(
      {
        ...MV3,
        manifest_version: undefined,
        "chromium:manifest_version": 3,
        "firefox:manifest_version": 2,
        "chromium:content_security_policy": { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'" },
        "firefox:content_security_policy": "script-src 'self' 'wasm-unsafe-eval'",
      },
      ["src/background.js"],
    );
    const plain = project(MV3, ["src/background.js"]);

    put(granted, "src/background.js", source);
    put(prefixed, "src/background.js", source);
    put(plain, "src/background.js", "chrome.runtime.onInstalled.addListener(() => fetch('https://api.example.com/v1/items'));\n");

    expect(wasmLines(await validate(granted))).toEqual([]);
    expect(wasmLines(await validate(prefixed))).toEqual([]);
    expect((await validate(plain)).value.warnings.join("\n")).not.toMatch(/WebAssembly|unsafe-eval/);
  });

  it("asks only the Manifest V3 views: a Firefox Manifest V2 view compiles without the grant", async () => {
    const dir = project({ ...MV3, manifest_version: undefined, "chromium:manifest_version": 3, "firefox:manifest_version": 2 }, ["src/background.js", "src/add.wasm"]);

    const lines = wasmLines(await validate(dir));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the project holds src/add.wasm, and the chrome, edge manifest has no 'wasm-unsafe-eval'");
  });

  it("reads 'unsafe-eval' and 'wasm-unsafe-eval' as two sources: the first is flagged with its replacement, the second never is", async () => {
    const unsafe = project({ ...MV3, content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'self'" } }, ["src/background.js", "src/add.wasm"]);
    const narrow = project({ ...MV3, content_security_policy: { extension_pages: POLICY } }, ["src/background.js", "src/add.wasm"]);

    const lines = (await validate(unsafe, ["chrome"])).value.warnings.filter((w: string) => w.includes("unsafe-eval"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("chrome: content_security_policy.extension_pages carries 'unsafe-eval', and Manifest V3 permits only 'self', 'none' and 'wasm-unsafe-eval' in script-src. For WebAssembly write 'wasm-unsafe-eval' in its place; otherwise remove it.");
    expect((await validate(narrow, ["chrome"])).value.warnings.join("\n")).not.toContain("unsafe-eval");
  });

  it("tells a policy that lacks the grant to add the source to its script-src", async () => {
    const dir = project({ ...MV3, content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" } }, ["src/background.js", "src/add.wasm"]);

    const lines = wasmLines(await validate(dir, ["chrome"]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Add 'wasm-unsafe-eval' to script-src in content_security_policy.extension_pages ("${POLICY}")`);
  });
});
