import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { handler } from "../tools/doctor";
import { ENGINE_BIN_ENV, ENGINE_DIR_ENV } from "../lib/engine-override";
import { projectEngineCheck, readProjectEngine } from "../lib/project-engine-check";

const saved = {
  dir: process.env[ENGINE_DIR_ENV],
  bin: process.env[ENGINE_BIN_ENV],
  pin: process.env.EXTENSION_MCP_CLI_VERSION,
};
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);

  return dir;
}

function writePackage(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "extension.cjs"), 'console.log("[]");\n');
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "extension", version }));
}

function fakeCheckout(version: string, branch: string): string {
  const root = tmp("mcp-doctor-checkout-");
  writePackage(path.join(root, "programs", "extension"), version);
  execFileSync("git", ["-C", root, "init", "-q", "-b", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

  return root;
}

function shortSha(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

function fakeProject(engine: { version: string } | { linkTo: string }): string {
  const dir = tmp("mcp-doctor-override-");
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, "#!/bin/sh\necho '[]'\n");
  fs.chmodSync(bin, 0o755);
  const pkgDir = path.join(dir, "node_modules", "extension");

  if ("linkTo" in engine) {
    fs.symlinkSync(engine.linkTo, pkgDir, "dir");
  } else {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "extension", version: engine.version }));
  }

  return dir;
}

afterEach(() => {
  for (const [key, value] of [
    [ENGINE_DIR_ENV, saved.dir],
    [ENGINE_BIN_ENV, saved.bin],
    ["EXTENSION_MCP_CLI_VERSION", saved.pin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const posixOnly = process.platform === "win32" ? it.skip : it;

function engineCheck(result: {
  value: { checks: Array<{ check: string; status: string; detail: string; remediation?: string }> };
}) {
  return result.value.checks.find((c) => c.check === "project-engine");
}

describe("extension_doctor project-engine under the engine override", () => {
  posixOnly(
    "passes and names the override, its version, sha and branch, bypassing the project engine and the pin",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
      const root = fakeCheckout("4.1.35", "engine-fix");
      process.env[ENGINE_DIR_ENV] = root;
      const project = fakeProject({ version: "3.9.9" });

      const result = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
      const check = engineCheck(result)!;

      expect(check.status).toBe("pass");
      expect(check.detail).toBe(
        `engine override: ${root} (extension@4.1.35, ${shortSha(root)} on engine-fix) is used for every spawn; the project's extension@3.9.9 and the MCP pin are bypassed`,
      );

      expect(check.remediation).toBeUndefined();
      expect(result.value.engineVersion).toBe("3.9.9");
    },
    20_000,
  );

  posixOnly(
    "fails with the expected paths when the override names no bin",
    async () => {
      const dir = tmp("mcp-doctor-empty-");
      process.env[ENGINE_DIR_ENV] = dir;
      const project = fakeProject({ version: "4.1.36" });

      const result = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
      const check = engineCheck(result)!;

      expect(check.status).toBe("fail");
      expect(check.detail).toContain(`${ENGINE_DIR_ENV}=${dir} names no engine bin`);
      expect(check.detail).toContain(path.join(dir, "programs", "extension", "bin", "extension.cjs"));
      expect(check.remediation).toContain(ENGINE_DIR_ENV);
      expect(result.ok).toBe(false);
    },
    20_000,
  );

  it("reports the override even when the project has no engine installed", () => {
    const root = fakeCheckout("4.1.35", "main");
    process.env[ENGINE_DIR_ENV] = root;
    const project = tmp("mcp-doctor-bare-");

    const check = projectEngineCheck(project)!;

    expect(check.status).toBe("pass");
    expect(check.detail).toContain("the project's engine (none installed) and the MCP pin are bypassed");
  });
});

describe("extension_doctor project-engine on a linked checkout", () => {
  posixOnly(
    "passes with the real path and sha of a symlinked checkout older than the pin",
    async () => {
      process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
      const root = fakeCheckout("4.1.35", "main");
      const packageDir = path.join(root, "programs", "extension");
      const project = fakeProject({ linkTo: packageDir });

      const result = JSON.parse(await handler({ projectPath: project, browser: "chrome" }));
      const check = engineCheck(result)!;

      expect(check.status).toBe("pass");
      expect(check.detail).toContain("linked checkout");
      expect(check.detail).toContain(fs.realpathSync(packageDir));
      expect(check.detail).toContain(`extension@4.1.35, ${shortSha(root)} on main`);
      expect(check.detail).toContain("extension@4.1.36 does not apply");
      expect(check.remediation).toBeUndefined();
      expect(result.value.engineVersion).toBe("4.1.35");
    },
    20_000,
  );

  it("still compares a pnpm-style symlink into node_modules with the pin", () => {
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.36";
    const project = tmp("mcp-doctor-pnpm-");
    const store = path.join(project, "node_modules", ".pnpm", "extension@3.9.9", "node_modules", "extension");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "package.json"), JSON.stringify({ name: "extension", version: "3.9.9" }));
    fs.symlinkSync(store, path.join(project, "node_modules", "extension"), "dir");

    const read = readProjectEngine(project)!;
    const check = projectEngineCheck(project)!;

    expect(read.linkedCheckout).toBe(false);
    expect(read.realPath).toBe(fs.realpathSync(store));
    expect(check.status).toBe("warn");
    expect(check.remediation).toContain("npm i -D extension@4.1.36");
  });
});
