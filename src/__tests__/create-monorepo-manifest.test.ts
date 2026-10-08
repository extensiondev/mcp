
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

let manifestRel = "packages/extension/src/manifest.json";
vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (input: string, opts: { template: string }) => {
    const target = path.resolve(input);
    const manifest = path.join(target, manifestRel);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, "{}");

    return { projectPath: target, projectName: path.basename(target), template: opts.template, depsInstalled: true, packageManager: "npm" };
  }),
}));

const create = await import("../tools/create");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-create-monorepo-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  manifestRel = "packages/extension/src/manifest.json";
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_create finds the manifest the way the scaffolder does on a monorepo template", () => {
  it("accepts a manifest at packages/extension/src and names it", async () => {
    const parent = tmpDir();
    const out = JSON.parse(await create.handler({ projectName: "mono", parentDir: parent, template: "sidebar-monorepo-turborepo" }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.manifestPath).toBe(path.join(parent, "mono", "packages", "extension", "src", "manifest.json"));
  });

  it("still calls a scaffold with no manifest within depth 3 incomplete, and says where it looked", async () => {
    manifestRel = "a/b/c/d/manifest.json";
    const parent = tmpDir();
    const out = JSON.parse(await create.handler({ projectName: "deep", parentDir: parent }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("scaffold-incomplete");
    expect(out.error.message).toMatch(/depth 3/);
  });

  it("skips node_modules the way the scaffolder does", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "manifest.json"), "{}");
    expect(create.findScaffoldManifest(root)).toBeNull();
    fs.mkdirSync(path.join(root, "extension", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "extension", "src", "manifest.json"), "{}");
    expect(create.findScaffoldManifest(root)).toBe(path.join(root, "extension", "src", "manifest.json"));
  });
});
