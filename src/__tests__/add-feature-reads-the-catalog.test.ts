
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

describe("list additions merge with the manifest's own values", () => {
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

describe("the catalog is read for every surface", () => {
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

describe("the plan ends at a build and follows the project", () => {
  const plain = { manifest_version: 3, name: "x", version: "1.0" };
  const paths = (out: { value: { filesToCreate: Array<{ path: string }> } }): string[] =>
    out.value.filesToCreate.map((f) => f.path);

  it("says to build after validating, and only then offers to open the browser", async () => {
    const out = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "options", framework: "vanilla" }));
    const last: string = out.value.instructions.at(-1);

    expect(last).toMatch(/extension_manifest_validate.*extension_build.*Want me to open it in Chrome.*extension_dev/s);
    expect(last).toMatch(/the validator reads only the manifest/);
    expect(last).toMatch(/compiles the scripts/);
  });

  it("reads a template with an empty uiFramework as vanilla", async () => {
    const out = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "options", framework: "vanilla" }));

    expect(out.warnings).toEqual([]);
    expect(rows.find((t) => t.slug === out.value.referenceTemplate.slug)?.uiFramework).toBe("");
  });

  it("writes an options surface and names the stand-in's framework when no template matches", async () => {
    const out = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "options", framework: "solid" }));

    expect(out.warnings.join("\n")).toMatch(/No solid template in the catalog ships an options surface; \S+ \((vanilla|react|vue|svelte|preact)\) is referenced/);
  });

  it("proposes JavaScript files for a project with no tsconfig and no TypeScript sources", async () => {
    const vanilla = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "options", framework: "vanilla" }));
    const react = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "options", framework: "react" }));
    const vue = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "content-script", framework: "vue" }));
    const background = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "background", framework: "vanilla" }));
    const sidebar = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature: "sidebar", framework: "vanilla" }));

    expect(paths(vanilla)).toContain("src/options/scripts.js");
    expect(paths(react)).toEqual(expect.arrayContaining(["src/options/scripts.jsx", "src/options/OptionsApp.jsx"]));
    expect(paths(vue)).toEqual(["src/content/scripts.js", "src/content/styles.css", "src/content/ContentApp.vue"]);
    expect(vue.value.manifestUpdates.content_scripts[0].js).toEqual(["content/scripts.js"]);
    expect(paths(background)).toEqual(["src/background.js"]);
    expect(background.value.manifestUpdates.background).toEqual({ "chromium:service_worker": "background.js", "firefox:scripts": ["background.js"] });
    expect(sidebar.value.instructions.join("\n")).toMatch(/Add background\.js/);

    for (const out of [vanilla, react, vue, background, sidebar]) {
      expect(JSON.stringify([out.value.manifestUpdates, out.value.filesToCreate, out.value.instructions])).not.toMatch(/\.tsx?\b/);
    }
  });

  it("proposes TypeScript files when the project has a tsconfig or TypeScript sources", async () => {
    const withConfig = project(plain);
    fs.writeFileSync(path.join(withConfig, "tsconfig.json"), "{}");
    const withSource = project(plain);
    fs.mkdirSync(path.join(withSource, "src", "content"));
    fs.writeFileSync(path.join(withSource, "src", "content", "scripts.ts"), "");

    for (const root of [withConfig, withSource]) {
      const vanilla = JSON.parse(await addFeature.handler({ projectPath: root, feature: "options", framework: "vanilla" }));
      const react = JSON.parse(await addFeature.handler({ projectPath: root, feature: "options", framework: "react" }));
      const vue = JSON.parse(await addFeature.handler({ projectPath: root, feature: "newtab", framework: "vue" }));

      expect(paths(vanilla)).toContain("src/options/scripts.ts");
      expect(paths(react)).toEqual(expect.arrayContaining(["src/options/scripts.tsx", "src/options/OptionsApp.tsx"]));
      expect(paths(vue)).toEqual(expect.arrayContaining(["src/newtab/scripts.ts", "src/newtab/shims-vue.d.ts"]));
    }
  });

  it("numbers the steps from 1 with no gap for every feature", async () => {
    for (const feature of ["sidebar", "popup", "options", "content-script", "background", "newtab", "devtools"]) {
      const out = JSON.parse(await addFeature.handler({ projectPath: project(plain), feature, framework: "vanilla" }));
      const numbers = (out.value.instructions as string[]).flatMap((line) => /^(\d+)\. /.exec(line)?.[1] ?? []).map(Number);

      expect(numbers, feature).toEqual(numbers.map((_, i) => i + 1));
      expect(numbers.length, feature).toBeGreaterThanOrEqual(4);
    }
  });
});
