import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let attempts: Array<{ targetExisted: boolean; gitSurvived: boolean }> = [];
let behavior: (input: string) => Promise<{
  projectPath: string;
  projectName: string;
  template: string;
  depsInstalled: boolean;
}> = async () => {
  throw new Error("behavior not set");
};

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(
    async (
      input: string,
      opts: { logger: { log: (...p: unknown[]) => void; error: (...p: unknown[]) => void } },
    ) => {
      attempts.push({
        targetExisted: fs.existsSync(input),
        gitSurvived: fs.existsSync(path.join(input, ".git", "config")),
      });
      opts.logger.error("fetch failed: network timeout while downloading template");
      return behavior(input);
    },
  ),
}));

const create = await import("../tools/create");

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-create-cleanup-"));
  tmpDirs.push(dir);
  return dir;
}

const previousEnvPin = process.env.EXTENSION_MCP_CLI_VERSION;

afterEach(() => {
  attempts = [];
  if (previousEnvPin === undefined) {
    delete process.env.EXTENSION_MCP_CLI_VERSION;
  } else {
    process.env.EXTENSION_MCP_CLI_VERSION = previousEnvPin;
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_create never wipes a pre-existing directory", () => {
  it("keeps the user's .git and files when the scaffold fails in an existing dir", async () => {
    const parent = tmpDir();
    const target = path.join(parent, "probe");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(target, "LICENSE"), "Apache-2.0\n");
    behavior = async (input) => {
      fs.writeFileSync(path.join(input, "partial.tmp"), "half a template");
      throw new Error("network timeout");
    };

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("template-fetch-failed");
    expect(fs.existsSync(path.join(target, ".git", "config"))).toBe(true);
    expect(fs.existsSync(path.join(target, "LICENSE"))).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].gitSurvived).toBe(true);
  });

  it("still clears a directory the tool itself created before retrying", async () => {
    const parent = tmpDir();
    const target = path.join(parent, "probe");
    behavior = async (input) => {
      fs.mkdirSync(input, { recursive: true });
      fs.writeFileSync(path.join(input, "partial.tmp"), "half a template");
      throw new Error("network timeout");
    };

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent }),
    );

    expect(result.ok).toBe(false);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].targetExisted).toBe(false);
    expect(attempts[1].targetExisted).toBe(false);
    expect(target).toContain(parent);
  });
});

describe("extension_create engine-pin drift warning", () => {
  function scaffoldSuccess(enginePin: string) {
    behavior = async (input) => {
      fs.mkdirSync(input, { recursive: true });
      fs.writeFileSync(path.join(input, "manifest.json"), "{}");
      fs.writeFileSync(
        path.join(input, "package.json"),
        JSON.stringify({ devDependencies: { extension: enginePin } }),
      );
      return {
        projectPath: input,
        projectName: path.basename(input),
        template: "typescript",
        depsInstalled: true,
      };
    };
  }

  it("warns on pin 4.0.1 vs scaffold ^4.0.17 instead of substring-matching it away", async () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.0.1";
    scaffoldSuccess("^4.0.17");

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: tmpDir() }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("^4.0.17");
    expect(result.warnings.join(" ")).toContain("EXTENSION_MCP_CLI_VERSION=4.0.1");
  });

  it("stays quiet when the scaffold pin matches exactly", async () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.0.17";
    scaffoldSuccess("^4.0.17");

    const result = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: tmpDir() }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).not.toContain("EXTENSION_MCP_CLI_VERSION");
  });
});
