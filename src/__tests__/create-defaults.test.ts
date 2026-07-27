import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


let scaffoldTarget = "";
let withGit = false;

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (_input: string, opts: { template: string }) => {
    fs.mkdirSync(scaffoldTarget, { recursive: true });
    fs.writeFileSync(path.join(scaffoldTarget, "manifest.json"), "{}");
    if (withGit) fs.mkdirSync(path.join(scaffoldTarget, ".git"));
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
  });
});
