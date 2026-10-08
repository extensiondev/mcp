import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";


import { scaffoldScripts } from "./fixtures/scaffolder-answers";

let scaffoldTarget = "";
let withGit = false;
let withScripts = false;

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (_input: string, opts: { template: string }) => {
    const monorepo = opts.template.includes("monorepo");
    const manifestDir = monorepo ? path.join(scaffoldTarget, "packages", "extension", "src") : scaffoldTarget;
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), "{}");
    if (withGit) fs.mkdirSync(path.join(scaffoldTarget, ".git"));

    if (withScripts) {
      fs.writeFileSync(
        path.join(scaffoldTarget, "package.json"),
        JSON.stringify({ name: path.basename(scaffoldTarget), scripts: scaffoldScripts(opts.template) }),
      );

      if (monorepo) {
        fs.writeFileSync(
          path.join(scaffoldTarget, "packages", "extension", "package.json"),
          JSON.stringify({ name: "extension" }),
        );
      }
    }

    return {
      projectPath: scaffoldTarget,
      projectName: path.basename(scaffoldTarget),
      template: opts.template,
      depsInstalled: true,
      packageManager: "bun",
    };
  }),
}));

const create = await import("../tools/create");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-create-defaults-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  withGit = false;
  withScripts = false;

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_create defaultsApplied", () => {
  it("echoes the resolved path and marks an explicit parentDir as explicit", async () => {
    const parent = tmpDir();
    scaffoldTarget = path.join(parent, "probe");

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent }),
    );

    expect(result.value.resolvedPath).toBe(scaffoldTarget);
    expect(result.value.defaultsApplied.parentDir).toContain(parent);
    expect(result.value.defaultsApplied.parentDir).toContain("(explicit)");
    expect(result.value.defaultsApplied.gitInit).toBe(false);
  });

  it("names the server-cwd default when parentDir is omitted", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.defaultsApplied.parentDir).toContain(process.cwd());
    expect(result.value.defaultsApplied.parentDir).toContain(
      "default: the MCP server process cwd",
    );
  });

  it("reports the auto-detected package manager and the chrome default", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.defaultsApplied.packageManager).toContain("bun");
    expect(result.value.defaultsApplied.packageManager).toContain("auto-detected");
    expect(result.value.defaultsApplied.browser).toContain("chrome");
    expect(result.value.defaultsApplied.browser).toContain("default");
    expect(result.value.scripts).toEqual([]);
  });

  it("lists every engine script with the browser it targets and the folder it writes", async () => {
    withScripts = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.scripts).toEqual([
      { name: "dev", run: "bun run dev", command: "extension dev", browser: "chromium", writes: "dist/chromium" },
      { name: "start", run: "bun run start", command: "extension start", browser: "chromium", writes: "dist/chromium" },
      { name: "build", run: "bun run build", command: "extension build", browser: "chromium", writes: "dist/chromium" },
      { name: "preview", run: "bun run preview", command: "extension preview", browser: "chromium", writes: null },
      { name: "build:chrome", run: "bun run build:chrome", command: "extension build --browser chrome", browser: "chrome", writes: "dist/chrome" },
      { name: "build:firefox", run: "bun run build:firefox", command: "extension build --browser firefox", browser: "firefox", writes: "dist/firefox" },
      { name: "build:edge", run: "bun run build:edge", command: "extension build --browser edge", browser: "edge", writes: "dist/edge" },
    ]);

    expect(result.value.nextSteps.join(" ")).toContain("bun run dev");
  });

  it("says the scaffold is verified without a build and that extension_dev is the next step", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));
    const steps: string[] = result.value.nextSteps;

    expect(steps[0]).toMatch(/^The scaffold is complete and verified \(manifest read at /);
    expect(steps[0]).toContain(result.value.manifestPath);
    expect(steps[0]).toMatch(/needs no build to check, so do not run a build to verify it\.$/);
    expect(steps[1]).toMatch(/^Run it with extension_dev \(projectPath: /);
    expect(steps[1]).toContain(scaffoldTarget);
    expect(steps.join(" ")).not.toMatch(/run build/);
    expect(create.schema.description).toMatch(/needs no build to prove it, so do not run `npm run build` to check it; the next step is extension_dev/);
  });

  it("resolves a monorepo script's folder under the package the engine builds", async () => {
    withScripts = true;
    scaffoldTarget = path.join(tmpDir(), "mono");

    const result = JSON.parse(
      await create.handler({ projectName: "mono", template: "sidebar-monorepo-turborepo" }),
    );

    const byName = Object.fromEntries(result.value.scripts.map((s: { name: string }) => [s.name, s]));
    expect(byName.build).toMatchObject({ command: "extension build packages/extension", browser: "chromium", writes: "packages/extension/dist/chromium" });
    expect(byName["build:chrome"]).toMatchObject({ browser: "chrome", writes: "packages/extension/dist/chrome" });
  });

  it("admits when the scaffolder initialized a git repository", async () => {
    withGit = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.value.defaultsApplied.gitInit).toBe(true);
  });

  it("documents the name alias and the cwd default in the schema itself", () => {
    const props = create.schema.inputSchema.properties;
    expect(props.projectName.description).toContain("Alias: name");
    expect(props.parentDir.description).toContain("MCP server process cwd");
    expect(create.schema.description).toContain("git repository");
    expect(create.schema.description).toMatch(/`scripts` .*dist\/chromium/);
  });
});
