import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Surprise-swarm cluster C4: extension_create decided silently (server cwd,
// auto-picked package manager, unrequested git repo, defaulted browser). These
// tests pin the fix: the result leads with the resolved destination and a
// defaultsApplied block that names every decision taken without being asked.

// The scaffold target the fake engine writes to; the handler trusts
// result.projectPath, so the fake can land the tree in a tmp dir regardless of
// what cwd-relative input it received.
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

    expect(result.resolvedPath).toBe(scaffoldTarget);
    expect(result.defaultsApplied.parentDir).toContain(parent);
    expect(result.defaultsApplied.parentDir).toContain("(explicit)");
    expect(result.defaultsApplied.gitInit).toBe(false);
  });

  it("names the server-cwd default when parentDir is omitted", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.defaultsApplied.parentDir).toContain(process.cwd());
    expect(result.defaultsApplied.parentDir).toContain(
      "default: the MCP server process cwd",
    );
  });

  it("reports the auto-detected package manager and the chrome default", async () => {
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.defaultsApplied.packageManager).toContain("bun");
    expect(result.defaultsApplied.packageManager).toContain("auto-detected");
    expect(result.defaultsApplied.browser).toContain("chrome");
    expect(result.defaultsApplied.browser).toContain("default");
  });

  it("admits when the scaffolder initialized a git repository", async () => {
    withGit = true;
    scaffoldTarget = path.join(tmpDir(), "probe");

    const result = JSON.parse(await create.handler({ projectName: "probe" }));

    expect(result.defaultsApplied.gitInit).toBe(true);
  });

  it("documents the name alias and the cwd default in the schema itself", () => {
    const props = create.schema.inputSchema.properties;
    expect(props.projectName.description).toContain("Alias: name");
    expect(props.parentDir.description).toContain("MCP server process cwd");
    expect(create.schema.description).toContain("git repository");
  });
});
