
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { contradictoryRef } from "../tools/store-status";
import { readReleases as releaseList } from "../tools/release-list";
import { handler as analyze } from "../tools/analyze";
import { handler as docsSearch } from "../tools/docs-search";
import { schema as sharesSchema } from "../tools/shares";

describe("the smaller sentences are cut to what was read or name their source", () => {
  it("names a workspace and project that disagree instead of saying there is no project", async () => {
    expect(contradictoryRef({ workspace: "acme", project: "other/widget" })).toMatch(/name different workspaces/);
    expect(contradictoryRef({ workspace: "acme", project: "acme/widget" })).toBeNull();
    expect(contradictoryRef({ project: "other/widget" })).toBeNull();
    const out = JSON.parse(await releaseList({ workspace: "acme", project: "other/widget" }));
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/name different workspaces/);
    expect(out.error.message).not.toMatch(/No project to list/);
  });

  it("dates no share-id claim", () => {
    const text = JSON.stringify(sharesSchema);
    expect(text).not.toMatch(/2026-07-30/);
  });

  it("names its own thresholds in the analyze answer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-analyze-notes-"));

    try {
      const dist = path.join(root, "dist", "chrome");
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ name: "x", version: "1.0", manifest_version: 3 }));
      fs.writeFileSync(path.join(dist, "bg.js"), "1");
      const out = JSON.parse(await analyze({ projectPath: root }));
      expect(out.value.storeReadinessNotes.under10MB).toMatch(/not a store limit/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists every page the manifest declares as an entry point, the new tab override included", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-analyze-entries-"));

    try {
      const dist = path.join(root, "dist", "chrome");
      fs.mkdirSync(path.join(dist, "newtab"), { recursive: true });
      fs.writeFileSync(path.join(dist, "newtab", "index.html"), "<html></html>");
      fs.writeFileSync(path.join(dist, "bg.js"), "1");
      fs.writeFileSync(
        path.join(dist, "manifest.json"),
        JSON.stringify({
          name: "x",
          version: "1.0",
          manifest_version: 3,
          background: { service_worker: "bg.js" },
          chrome_url_overrides: { newtab: "newtab/index.html" },
          options_ui: { page: "options.html" },
          devtools_page: "devtools.html",
        }),
      );

      const out = JSON.parse(await analyze({ projectPath: root }));
      const roles = (out.value.entrypoints as Array<{ role: string; present: boolean }>).map((e) => `${e.role}:${e.present}`);
      expect(roles).toEqual(expect.arrayContaining([
        "background.service_worker:true",
        "chrome_url_overrides.newtab:true",
        "options_ui.page:false",
        "devtools_page:false",
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe("docs search under the hold", () => {
    beforeEach(() => {
      vi.stubEnv("EXTENSION_DEV_API_URL", "https://www.extension.dev");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ query: "x", results: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("says platform pages can be filtered out while the hold is on", async () => {
      const out = JSON.parse(await docsSearch({ query: "billing" }));
      expect(out.status).toBe("no-match");
      expect(out.hint).toMatch(/filters its own platform pages out/);
    });
  });
});
