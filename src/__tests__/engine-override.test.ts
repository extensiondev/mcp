import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  ENGINE_BIN_ENV,
  ENGINE_DIR_ENV,
  describeEngineOverride,
  readGitFacts,
  resolveEngineOverride,
} from "../lib/engine-override";
import {
  describeExtensionInvocation,
  resolveExtensionInvocation,
  runExtensionCli,
  spawnExtensionCli,
  spawnFailedEnvelope,
} from "../lib/exec";

const saved = {
  dir: process.env[ENGINE_DIR_ENV],
  bin: process.env[ENGINE_BIN_ENV],
};
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);

  return dir;
}

const ECHO_ARGS = 'console.log(process.argv.slice(2).join(" "));\n';

function fakePackage(dir: string, version = "4.1.35", script = ECHO_ARGS): string {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "extension.cjs"), script);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "extension", version }),
  );

  return path.join(dir, "bin", "extension.cjs");
}

function fakeCheckout(version = "4.1.35"): { root: string; bin: string } {
  const root = tmp("mcp-engine-checkout-");
  const bin = fakePackage(path.join(root, "programs", "extension"), version);

  return { root, bin };
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function initRepo(dir: string, branch: string): void {
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "seed"]);
}

function fakeProjectWithBin(): string {
  const dir = tmp("mcp-engine-project-");
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, "#!/bin/sh\necho project-bin\n");
  fs.chmodSync(bin, 0o755);

  return dir;
}

afterEach(() => {
  for (const [key, value] of [
    [ENGINE_DIR_ENV, saved.dir],
    [ENGINE_BIN_ENV, saved.bin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("EXTENSION_MCP_ENGINE_DIR resolves to the engine bin", () => {
  it("accepts an Extension.js checkout root and finds programs/extension/bin/extension.cjs", () => {
    const { root, bin } = fakeCheckout();

    const override = resolveEngineOverride({ [ENGINE_DIR_ENV]: root });

    expect(override?.bin).toBe(bin);
    expect(override?.packageDir).toBe(path.join(root, "programs", "extension"));
    expect(override?.env).toBe(ENGINE_DIR_ENV);
  });

  it("accepts a built extension package dir and finds bin/extension.cjs", () => {
    const dir = tmp("mcp-engine-package-");
    const bin = fakePackage(dir);

    const override = resolveEngineOverride({ [ENGINE_DIR_ENV]: dir });

    expect(override?.bin).toBe(bin);
    expect(override?.packageDir).toBe(dir);
  });

  it("answers no bin for a dir holding neither shape, naming both expected paths", () => {
    const dir = tmp("mcp-engine-empty-");

    const override = resolveEngineOverride({ [ENGINE_DIR_ENV]: dir });

    expect(override?.bin).toBeNull();
    expect(override?.packageDir).toBeNull();
    expect(override?.expected).toContain(path.join(dir, "programs", "extension", "bin", "extension.cjs"));
    expect(override?.expected).toContain(path.join(dir, "bin", "extension.cjs"));
  });

  it("reads EXTENSION_MCP_ENGINE_BIN as the exact bin file, and the dir spelling wins when both are set", () => {
    const dir = tmp("mcp-engine-package-");
    const bin = fakePackage(dir);
    const { root, bin: checkoutBin } = fakeCheckout();

    expect(resolveEngineOverride({ [ENGINE_BIN_ENV]: bin })).toMatchObject({
      env: ENGINE_BIN_ENV,
      bin,
      packageDir: dir,
    });

    expect(resolveEngineOverride({ [ENGINE_BIN_ENV]: path.join(dir, "missing.cjs") })?.bin).toBeNull();
    expect(resolveEngineOverride({ [ENGINE_DIR_ENV]: root, [ENGINE_BIN_ENV]: bin })?.bin).toBe(checkoutBin);
    expect(resolveEngineOverride({})).toBeNull();
    expect(resolveEngineOverride({ [ENGINE_DIR_ENV]: "  " })).toBeNull();
  });
});

describe("git facts of a local engine", () => {
  it("reads the short sha and the branch of a checkout, never a literal", () => {
    const { root } = fakeCheckout();
    initRepo(root, "engine-fix");

    const facts = readGitFacts(path.join(root, "programs", "extension"));

    expect(facts).toEqual({ sha: git(root, ["rev-parse", "--short", "HEAD"]), branch: "engine-fix" });
    expect(facts!.sha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("answers a null branch for a detached HEAD", () => {
    const { root } = fakeCheckout();
    initRepo(root, "main");
    git(root, ["checkout", "-q", "--detach"]);

    expect(readGitFacts(root)).toEqual({ sha: git(root, ["rev-parse", "--short", "HEAD"]), branch: null });
  });

  it("answers null outside a repository and under node_modules", () => {
    const bare = tmp("mcp-engine-norepo-");
    const { root } = fakeCheckout();
    initRepo(root, "main");
    const installed = path.join(root, "node_modules", "extension");
    fs.mkdirSync(installed, { recursive: true });

    expect(readGitFacts(bare)).toBeNull();
    expect(readGitFacts(installed)).toBeNull();
  });
});

describe("the chosen command under the override", () => {
  it("runs node <bin> for every spawn, over the project's own bin and the npx pin", async () => {
    const { root, bin } = fakeCheckout();
    const project = fakeProjectWithBin();
    process.env[ENGINE_DIR_ENV] = root;

    expect(resolveExtensionInvocation(project)).toEqual({ command: process.execPath, prefixArgs: [bin] });
    expect(resolveExtensionInvocation()).toEqual({ command: process.execPath, prefixArgs: [bin] });

    const run = await runExtensionCli(["build", project, "--browser=chrome"], { cwd: project });

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(`build ${project} --browser=chrome`);
  });

  it("names the override, its version, sha and branch in the engine sentence", () => {
    const { root, bin } = fakeCheckout("4.1.37");
    initRepo(root, "canary-fix");
    process.env[ENGINE_DIR_ENV] = root;

    const sentence = describeExtensionInvocation(fakeProjectWithBin());

    expect(sentence).toContain(bin);
    expect(sentence).toContain(`${ENGINE_DIR_ENV}=${root}`);
    expect(sentence).toContain(`extension@4.1.37, ${git(root, ["rev-parse", "--short", "HEAD"])} on canary-fix`);
    expect(sentence).toContain("bypassed");
    expect(sentence).not.toContain("pinned engine");
  });

  it("says detached when the checkout has no branch", () => {
    const { root } = fakeCheckout("4.1.37");
    initRepo(root, "main");
    git(root, ["checkout", "-q", "--detach"]);

    const sentence = describeEngineOverride(resolveEngineOverride({ [ENGINE_DIR_ENV]: root })!);

    expect(sentence).toContain(`${git(root, ["rev-parse", "--short", "HEAD"])} detached`);
  });
});

describe("a set override with no bin refuses every spawn", () => {
  it("answers the refusal from runExtensionCli instead of falling back", async () => {
    const dir = tmp("mcp-engine-empty-");
    const project = fakeProjectWithBin();
    process.env[ENGINE_DIR_ENV] = dir;

    const chosen = resolveExtensionInvocation(project);
    const run = await runExtensionCli(["--version"], { cwd: project });

    expect(chosen.refusal).toContain(`${ENGINE_DIR_ENV}=${dir}`);
    expect(chosen.refusal).toContain(path.join(dir, "programs", "extension", "bin", "extension.cjs"));
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(chosen.refusal);
    expect(describeExtensionInvocation(project)).toBe(chosen.refusal);
  });

  it("answers the refusal from spawnExtensionCli and the spawn-failed envelope", async () => {
    const dir = tmp("mcp-engine-empty-");
    const project = fakeProjectWithBin();
    process.env[ENGINE_DIR_ENV] = dir;

    const spawned = spawnExtensionCli(["dev", project], { projectDir: project });
    const parsed = JSON.parse(await spawnFailedEnvelope("extension_dev", spawned));

    expect(spawned.child.pid).toBeUndefined();
    expect(spawned.spawnError?.()?.message).toContain(`${ENGINE_DIR_ENV}=${dir} names no engine bin`);
    expect(spawned.readOutput()).toContain("names no engine bin");
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("spawn-failed");
    expect(parsed.error.message).toContain(`${ENGINE_DIR_ENV}=${dir} names no engine bin`);
    expect(parsed.hint).toContain(ENGINE_DIR_ENV);
  });
});
