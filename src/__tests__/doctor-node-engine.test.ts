// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { handler } from "../tools/doctor";
import { ENGINE_BIN_ENV, ENGINE_DIR_ENV } from "../lib/engine-override";
import { engineNodeRange, nodeCheck } from "../lib/node-engine";

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

function writeEngine(dir: string, version: string, node: string | null): void {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "extension.cjs"), 'console.log("[]");\n');
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "extension", version, ...(node ? { engines: { node } } : {}) }),
  );
}

function fakeOverride(version: string, node: string | null): string {
  const dir = tmp("mcp-doctor-node-override-");
  writeEngine(dir, version, node);

  return dir;
}

function fakeProject(version: string, node: string | null): string {
  const dir = tmp("mcp-doctor-node-project-");
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, "#!/bin/sh\necho '[]'\n");
  fs.chmodSync(bin, 0o755);
  writeEngine(path.join(dir, "node_modules", "extension"), version, node);

  return dir;
}

function nodeLeg(result: {
  value: { checks: Array<{ check: string; status: string; detail: string; remediation?: string; engine?: { source: string; version: string; range: string | null } }> };
}) {
  return result.value.checks.find((c) => c.check === "node");
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

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("the doctor's node leg reads the engine the server will spawn", () => {
  it("reads the override's engines.node and names the override", () => {
    const root = fakeOverride("9.9.9", ">=99.1");
    process.env[ENGINE_DIR_ENV] = root;

    const read = engineNodeRange()!;
    expect(read).toMatchObject({ source: "override", engine: "9.9.9", range: ">=99.1" });

    const check = nodeCheck("24.18.1");
    expect(check.status).toBe("fail");
    expect(check.detail).toBe(
      `Node 24.18.1 on ${process.platform}/${process.arch}; the engine override ${ENGINE_DIR_ENV}=${root} (extension 9.9.9) needs >=99.1.`,
    );

    expect(check.remediation).toContain(`the engine override ${ENGINE_DIR_ENV}=${root} (extension 9.9.9), needs Node >=99.1`);
    expect(check.engine).toEqual({ source: "override", version: "9.9.9", range: ">=99.1" });
    expect(check.detail).not.toContain("extension-develop");
  });

  it("reads the override before the project's engine when both are present", () => {
    const root = fakeOverride("9.9.9", ">=1.0");
    process.env[ENGINE_DIR_ENV] = root;
    const project = fakeProject("5.5.5", ">=99.1");

    const check = nodeCheck("24.18.1", project);
    expect(check.status).toBe("pass");
    expect(check.engine?.source).toBe("override");
    expect(check.detail).toContain("extension 9.9.9");
    expect(check.detail).not.toContain("5.5.5");
  });

  it("warns and names the override when it declares no Node range", () => {
    const root = fakeOverride("9.9.9", null);
    process.env[ENGINE_DIR_ENV] = root;

    const check = nodeCheck("24.18.1");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(`the engine override ${ENGINE_DIR_ENV}=${root} (extension 9.9.9) declares no Node range`);
    expect(check.engine).toEqual({ source: "override", version: "9.9.9", range: null });
  });

  it("names a dead override instead of reading the bundled engine behind it", () => {
    const dir = tmp("mcp-doctor-node-dead-");
    process.env[ENGINE_DIR_ENV] = dir;

    const check = nodeCheck("24.18.1");
    expect(check.status).toBe("warn");
    expect(check.engine?.source).toBe("override");
    expect(check.detail).toContain(`${ENGINE_DIR_ENV}=${dir} (extension unknown) declares no Node range`);
    expect(check.detail).not.toContain("extension-develop");
  });

  it("reads the project's engine when no override is set", () => {
    delete process.env[ENGINE_DIR_ENV];
    delete process.env[ENGINE_BIN_ENV];
    const project = fakeProject("5.5.5", ">=1.0");

    const read = engineNodeRange(project)!;
    expect(read).toMatchObject({ source: "project", engine: "5.5.5", range: ">=1.0" });

    const check = nodeCheck("24.18.1", project);
    expect(check.status).toBe("pass");
    expect(check.detail).toBe(
      `Node 24.18.1 on ${process.platform}/${process.arch}; the project's extension 5.5.5 needs >=1.0.`,
    );

    expect(check.engine).toEqual({ source: "project", version: "5.5.5", range: ">=1.0" });
  });

  it("falls back to the bundled extension-develop when the project has no engine", () => {
    delete process.env[ENGINE_DIR_ENV];
    delete process.env[ENGINE_BIN_ENV];
    const project = tmp("mcp-doctor-node-bare-");

    const withProject = engineNodeRange(project)!;
    const bare = engineNodeRange()!;
    expect(withProject.source).toBe("bundled");
    expect(bare.source).toBe("bundled");
    expect(bare.range).toBe(">=22.12");

    const check = nodeCheck("24.18.1", project);
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(`this server's bundled extension-develop ${bare.engine} needs >=22.12.`);
    expect(check.engine?.source).toBe("bundled");
  });

  posixOnly(
    "the pre-flight answer's node leg names the override, beside the extension-cli leg that already does",
    async () => {
      const root = fakeOverride("9.9.9", ">=99.1");
      process.env[ENGINE_DIR_ENV] = root;

      const result = JSON.parse(await handler({}));
      const node = nodeLeg(result)!;
      const cli = result.value.checks.find((c: { check: string }) => c.check === "extension-cli");

      expect(node.status).toBe("fail");
      expect(node.detail).toContain(`the engine override ${ENGINE_DIR_ENV}=${root} (extension 9.9.9) needs >=99.1`);
      expect(node.engine).toEqual({ source: "override", version: "9.9.9", range: ">=99.1" });
      expect(cli.detail).toContain(`from the engine override ${ENGINE_DIR_ENV}=${root}`);
      expect(result.ok).toBe(false);
    },
    20_000,
  );
});
