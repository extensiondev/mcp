
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as TemplatesCacheModule from "../lib/templates-cache";

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
