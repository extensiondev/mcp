/* @invariant
  * the scaffolder's own card (name, template, path) goes through the captured
  * logger, so the words in a project's name must never make its failure read
  * as a network error, and a `.git` that was there before the call is not one
  * the scaffolder initialized.
  */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

let attempts = 0;

let behavior: (input: string, log: (...p: unknown[]) => void) => Promise<unknown> = async () => {
  throw new Error("behavior not set");
};

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(
    async (
      input: string,
      opts: { template: string; logger: { log: (...p: unknown[]) => void; error: (...p: unknown[]) => void } },
    ) => {
      attempts += 1;
      opts.logger.log(`Extension: ${path.basename(input)}`);
      opts.logger.log(`Template: ${opts.template}`);
      opts.logger.log(`Path: ${path.resolve(input)}`);

      return behavior(input, opts.logger.log);
    },
  ),
}));

const create = await import("../tools/create");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-create-classify-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  attempts = 0;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_create transient classifier", () => {
  it("does not retry or blame the network for a project named network-monitor", async () => {
    const parent = tmpDir();

    behavior = async () => {
      throw new Error("Template 'nope' not found in the catalog");
    };

    const out = JSON.parse(
      await create.handler({ projectName: "network-monitor", parentDir: parent, template: "nope" }),
    );
    expect(attempts).toBe(1);
    expect(out.status).toBe("scaffold-failed");
    expect(out.error.message).toMatch(/not found in the catalog/);
  });

  it("does not blame the network for a parent directory named timeout-tools", async () => {
    const parent = path.join(tmpDir(), "timeout-tools");
    fs.mkdirSync(parent);

    behavior = async () => {
      throw new Error("Template 'nope' not found in the catalog");
    };

    const out = JSON.parse(
      await create.handler({ projectName: "probe", parentDir: parent, template: "nope" }),
    );
    expect(attempts).toBe(1);
    expect(out.status).toBe("scaffold-failed");
  });

  it("still classifies a real fetch timeout from the thrown error alone", async () => {
    const parent = tmpDir();

    behavior = async () => {
      throw new Error("fetch failed: ETIMEDOUT");
    };

    const out = JSON.parse(await create.handler({ projectName: "probe", parentDir: parent }));
    expect(attempts).toBe(2);
    expect(out.status).toBe("template-fetch-failed");
  });

  it("reports gitInit only for a .git this call created", async () => {
    const parent = tmpDir();
    const target = path.join(parent, "probe");
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });

    behavior = async (input) => {
      fs.writeFileSync(path.join(input, "manifest.json"), "{}");

      return { projectPath: input, projectName: "probe", template: "typescript", depsInstalled: true, packageManager: "npm" };
    };

    const kept = JSON.parse(await create.handler({ projectName: "probe", parentDir: parent }));
    expect(kept.ok).toBe(true);
    expect(kept.value.defaultsApplied.gitInit).toBe(false);

    const fresh = tmpDir();

    behavior = async (input) => {
      fs.mkdirSync(path.join(input, ".git"), { recursive: true });
      fs.writeFileSync(path.join(input, "manifest.json"), "{}");

      return { projectPath: input, projectName: "probe", template: "typescript", depsInstalled: true, packageManager: "npm" };
    };

    const made = JSON.parse(await create.handler({ projectName: "probe", parentDir: fresh }));
    expect(made.value.defaultsApplied.gitInit).toBe(true);
  });
});
