/* @invariant
  * a list addition merges with what the manifest declares instead of
  * replacing it through a prefixed key, and the catalog is read before saying
  * no template ships a surface.
  */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import snapshot from "../lib/templates-meta.snapshot.json";

import type * as TemplatesCacheModule from "../lib/templates-cache";

type Row = { slug: string; surfaces?: string[]; uiFramework?: string; keyFiles?: string[]; files?: string[] };
const rows = (snapshot as { templates: Row[] }).templates;
vi.mock("../lib/templates-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof TemplatesCacheModule>();

  return {
    ...actual,
    listTemplates: async (filters?: { surface?: string }) =>
      rows.filter((t) => !filters?.surface || (t.surfaces ?? []).includes(filters.surface)),
    getTemplateBySlug: async (slug: string) => rows.find((t) => t.slug === slug),
  };
});

const addFeature = await import("../tools/add-feature");

const tmpDirs: string[] = [];

function project(manifest: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-addfeat-catalog-"));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "manifest.json"), JSON.stringify(manifest));

  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("97b: list additions merge with the manifest's own values", () => {
  it("keeps existing permissions beside sidePanel instead of replacing them on Chromium", async () => {
    const root = project({ manifest_version: 3, name: "x", version: "1.0", permissions: ["storage", "tabs"] });
    const out = JSON.parse(await addFeature.handler({ projectPath: root, feature: "sidebar", framework: "vanilla" }));
    expect(out.value.manifestUpdates["chromium:permissions"]).toEqual(["storage", "tabs", "sidePanel"]);
    expect(out.value.manifestMerged).toEqual(["chromium:permissions"]);
    expect(out.value.manifestConflicts).not.toContain("chromium:permissions");
    expect(out.warnings.join("\n")).toMatch(/already declared values/);
  });

  it("merges with the prefixed key when the manifest already uses one", async () => {
    const root = project({ manifest_version: 3, name: "x", version: "1.0", "chromium:permissions": ["storage"], permissions: ["tabs"] });
    const out = JSON.parse(await addFeature.handler({ projectPath: root, feature: "sidebar", framework: "vanilla" }));
    expect(out.value.manifestUpdates["chromium:permissions"]).toEqual(["storage", "sidePanel"]);
  });
});

describe("97c: the catalog is read for every surface", () => {
  it("references a devtools and an options template the catalog ships", async () => {
    const root = project({ manifest_version: 3, name: "x", version: "1.0" });

    for (const feature of ["devtools", "options"]) {
      const out = JSON.parse(await addFeature.handler({ projectPath: root, feature }));
      expect(out.value.referenceTemplate, feature).toBeDefined();
      const row = rows.find((t) => t.slug === out.value.referenceTemplate.slug);
      expect(row?.surfaces, feature).toContain(feature);
      expect(out.value.instructions.join("\n")).toMatch(/Reference template source/);
      expect(out.value.instructions.join("\n")).not.toMatch(/No catalog template ships this surface yet/);
    }
  });
});
