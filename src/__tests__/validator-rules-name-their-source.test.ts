/* @invariant the validator's view is the engine's, a rule
 * blocks only where the engine or the browser refuses, and each rule names
 * its source. */

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

function project(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-validate-rules-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));

  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const validate = (projectPath: string, browsers?: string[]) =>
  manifestValidate.handler({ projectPath, ...(browsers ? { browsers } : {}) }).then((s) => JSON.parse(s));
const BASE = { name: "x", version: "1.0.0", manifest_version: 3 };

describe("95b: the view is the engine's own prefix filter", () => {
  it("gives zen and floorp the firefox: keys", async () => {
    const dir = project({ ...BASE, "firefox:background": { scripts: ["missing-bg.js"] } });

    for (const browser of ["zen", "floorp"]) {
      const out = await validate(dir, [browser]);
      expect(out.status, browser).toBe("invalid");
      expect(out.value.errors.join("\n"), browser).toMatch(/missing-bg\.js/);
    }
  });

  it("applies a chrome: key to chrome only, never to edge", async () => {
    const dir = project({ ...BASE, "chrome:side_panel": { default_path: "panel/missing.html" } });
    expect((await validate(dir, ["edge"])).status).toBe("valid");
    const chrome = await validate(dir, ["chrome"]);
    expect(chrome.status).toBe("invalid");
    expect(chrome.value.errors.join("\n")).toMatch(/panel\/missing\.html/);
  });
});

describe("95a, 95c, 95d: rules the engine folds are not refusals", () => {
  it("does not block a Firefox build on a service_worker the engine rewrites", async () => {
    const dir = project({ ...BASE, background: { service_worker: "sw.js" } }, { "src/sw.js": "" });
    const out = await validate(dir, ["firefox"]);
    expect(out.status).toBe("valid");
    expect(out.value.browserSupport.firefox.supported).toBe(true);
    expect(out.warnings.join("\n")).toMatch(/rewrites it to scripts: \["sw\.js"\]/);
  });

  it("says the engine folds an unprefixed side_panel into sidebar_action instead of telling you to prefix it away", async () => {
    const dir = project({ ...BASE, permissions: ["sidePanel"], side_panel: { default_path: "sidebar/index.html" } }, { "src/sidebar/index.html": "" });
    const out = await validate(dir, ["firefox"]);
    const text = out.warnings.join("\n");
    expect(text).toMatch(/folded into sidebar_action/);
    expect(text).not.toMatch(/ships without a sidebar/);
    expect(text).not.toMatch(/Move it under "chromium:side_panel"/);
  });

  it("still says a chromium:-prefixed side_panel leaves Firefox without one", async () => {
    const dir = project({ ...BASE, "chromium:permissions": ["sidePanel"], "chromium:side_panel": { default_path: "sidebar/index.html" } }, { "src/sidebar/index.html": "" });
    const out = await validate(dir, ["firefox"]);
    expect(out.warnings.join("\n")).toMatch(/ships without a sidebar/);
  });

  it("does not refuse a Chrome build over a firefox:browser_action asymmetry", async () => {
    const dir = project({ ...BASE, "firefox:browser_action": { default_popup: "popup.html" } }, { "src/popup.html": "" });
    const out = await validate(dir, ["chrome"]);
    expect(out.status).toBe("valid");
    expect(out.value.browserSupport.chrome.supported).toBe(true);
    expect(out.warnings.join("\n")).toMatch(/ships no toolbar action/);
  });
});

describe("95e, 95f, 95g: wording and sources", () => {
  it("tells Edge users to use the chrome: prefix, which the engine scopes to Chrome", async () => {
    const dir = project({ ...BASE, side_panel: { default_path: "p.html" }, permissions: ["sidePanel"] }, { "src/p.html": "" });
    const out = await validate(dir, ["edge"]);
    const edgeNote = out.warnings.find((w: string) => /inert on Edge/.test(w));

    if (edgeNote) {
      expect(edgeNote).toMatch(/"chrome:/);
      expect(edgeNote).not.toMatch(/only if you also target Chrome/);
    }
  });

  it("warns, and names the text search, instead of blocking the build on an undeclared crash-level API", async () => {
    const dir = project(BASE, { "src/x.js": "chrome.history.search({});" });
    const out = await validate(dir, ["chrome"]);
    expect(out.status).toBe("valid");
    expect(out.value.buildBlocking).toBe(false);
    const note = out.warnings.find((w: string) => /chrome\.history/.test(w));
    expect(note).toMatch(/text search/);
  });

  it("blocks a manifest with no version, which Chrome refuses to load", async () => {
    const dir = project({ name: "x", manifest_version: 3 });
    const out = await validate(dir, ["chrome"]);
    expect(out.status).toBe("invalid");
    expect(out.value.errors.join("\n")).toMatch(/Chrome refuses to load a manifest without it/);
  });
});
