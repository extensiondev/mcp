/* @invariant
  * "valid" is said only for what was checked. References are checked in every
  * requested browser's view, an unknown target is refused, the default build
  * target's issues block, and the permission scan says when it stopped.
  */

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

describe("75a: references are checked in each requested browser's view", () => {
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

  it("does not block a Firefox-only validation on a missing chromium:-only file", async () => {
    const dir = project({ ...BASE, "chromium:side_panel": { default_path: "panel/missing.html" } });
    const out = await validate(dir, ["firefox"]);
    expect(out.status).toBe("valid");
    const chrome = await validate(dir, ["chrome"]);
    expect(chrome.status).toBe("invalid");
    expect(chrome.value.errors.join("\n")).toMatch(/panel\/missing\.html.*chrome view/);
  });
});

describe("75b: an unknown browser is refused, an empty list is the default list", () => {
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
    expect(out.warnings.join("\n")).toMatch(/safari: checked as its Chromium source manifest/);
  });
});

describe("75c: the default build target's issues stay blocking", () => {
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

describe("75d: the permission scan reaches src/ first and says when it stopped", () => {
  it("finds the crash-level API under src/ past 301 files that sort before it, and reports the cap", async () => {
    const dir = project(
      { manifest_version: 3, name: "x", version: "1.0.0" },
      [...Array.from({ length: 301 }, (_, i) => `a/f${String(i).padStart(3, "0")}.js`)],
      "root",
    );
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "x.js"), "chrome.history.search({});");
    const out = await validate(dir, ["chrome"]);
    expect(out.warnings.join("\n")).toMatch(/chrome\.history/);
    expect(out.warnings.join("\n")).toMatch(/stopped at its cap/);
  });

  it("reports a source file it could not read", async () => {
    const dir = project({ manifest_version: 3, name: "x", version: "1.0.0" }, ["src/ok.js"]);
    fs.symlinkSync("/nowhere/at/all.js", path.join(dir, "src", "gone.js"));
    const out = await validate(dir, ["chrome"]);
    expect(out.warnings.join("\n")).toMatch(/could not be read.*gone\.js/);
  });
});
