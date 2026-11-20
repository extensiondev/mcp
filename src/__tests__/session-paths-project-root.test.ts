import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";
import * as bridge from "extension-develop/bridge";

import {
  engineProjectRoot,
  projectRootNote,
  storeMdPath,
  readyContractPath,
  logsPath,
  sessionArtifactsRootDir,
} from "../lib/session-paths";

const dirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-project-root-"));
  dirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("session artifacts resolve from the engine's project root, the nearest package.json above the manifest", () => {
  it("keeps a folder with no manifest in it as its own root, as the engine does, whatever package.json sits above", () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    const sub = path.join(repo, "Extensions", "combined");
    fs.mkdirSync(sub, { recursive: true });

    expect(engineProjectRoot(sub)).toBe(sub);
    expect(engineProjectRoot(sub)).toBe(bridge.resolveSessionProjectRoot(sub));
    expect(engineProjectRoot(repo)).toBe(repo);
    expect(readyContractPath(sub, "chrome")).toBe(bridge.readyContractPath(sub, "chrome"));
    expect(logsPath(sub, "firefox")).toBe(bridge.logsPath(sub, "firefox"));
    expect(sessionArtifactsRootDir(sub)).toBe(bridge.sessionArtifactsRootDir(sub));
  });

  it("stops at the nearest manifest, so a nested package keeps its own dist", () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    const nested = path.join(repo, "packages", "ext");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "deno.json"), "{}");

    expect(engineProjectRoot(nested)).toBe(nested);
    expect(readyContractPath(nested, "chrome")).toBe(bridge.readyContractPath(nested, "chrome"));
  });

  it("leaves a project with no package manifest where it is", () => {
    const bare = tmp();

    expect(engineProjectRoot(bare)).toBe(path.resolve(bare));
    expect(readyContractPath(bare, "chrome")).toBe(bridge.readyContractPath(bare, "chrome"));
  });
});

describe("a package root is adopted only when it owns the manifest, as the engine decides since 4.1.31", () => {
  function manifestAt(dir: string, sub = ""): string {
    const where = sub ? path.join(dir, sub) : dir;
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F" }));

    return where;
  }

  it("declines a stranger's package.json and makes the manifest folder the project", () => {
    const stranger = tmp();
    fs.writeFileSync(path.join(stranger, "package.json"), JSON.stringify({ name: "stranger" }));
    const inner = manifestAt(stranger, "inner");

    expect(engineProjectRoot(inner)).toBe(inner);
    expect(readyContractPath(inner, "chrome")).toBe(bridge.readyContractPath(inner, "chrome"));
  });

  it("925: keeps the folder passed as the root of a src layout with no package.json, where the engine writes dist from 4.2.0", () => {
    const bare = tmp();
    const src = manifestAt(bare, "src");

    expect(engineProjectRoot(bare)).toBe(path.resolve(bare));
    expect(engineProjectRoot(src)).toBe(path.resolve(src));
    expect(fs.realpathSync(engineProjectRoot(bare))).toBe(fs.realpathSync(bridge.resolveSessionProjectRoot(bare)));
    expect(fs.realpathSync(engineProjectRoot(src))).toBe(fs.realpathSync(bridge.resolveSessionProjectRoot(src)));
    expect(readyContractPath(bare, "chrome")).toBe(bridge.readyContractPath(bare, "chrome"));
    expect(projectRootNote(bare)).toBeNull();
    expect(storeMdPath(bare)).toBe(path.join(bare, "STORE.md"));
    fs.writeFileSync(path.join(src, "STORE.md"), "# Store\n");
    expect(storeMdPath(bare)).toBe(path.join(bare, "STORE.md"));
  });

  it("925: says nothing about the root when it is the folder passed, and names a package root above it in a short line", () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "plain" }));
    const src = manifestAt(repo, "src");

    expect(projectRootNote(repo)).toBeNull();
    expect(projectRootNote(src)).toBe(`Project root: ${repo}, the folder of the package.json or deno.json that owns this manifest; dist, zips and STORE.md live there.`);
    expect(projectRootNote(manifestAt(tmp()))).toBeNull();
    expect(storeMdPath(src)).toBe(path.join(repo, "STORE.md"));
  });

  it("keeps the documented src layout on the package root whatever the package declares", () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "plain" }));
    manifestAt(repo, "src");

    expect(engineProjectRoot(repo)).toBe(repo);
  });

  it("adopts a root that depends on Extension.js from a nested manifest folder", () => {
    const repo = tmp();
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "ryd", devDependencies: { extension: "^4.1.30" } }),
    );

    const combined = manifestAt(repo, path.join("Extensions", "combined"));

    expect(engineProjectRoot(combined)).toBe(repo);
    expect(readyContractPath(combined, "chrome")).toBe(bridge.readyContractPath(repo, "chrome"));
  });

  it("adopts a root that carries an extension.config beside its package.json", () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "configured" }));
    fs.writeFileSync(path.join(repo, "extension.config.js"), "module.exports = {}\n");
    const nested = manifestAt(repo, "ext");

    expect(engineProjectRoot(nested)).toBe(repo);
  });

  it("reads a Deno project's npm: specifiers as a declaration", () => {
    const repo = tmp();
    fs.writeFileSync(
      path.join(repo, "deno.json"),
      JSON.stringify({ imports: { extension: "npm:extension@4.1.30" } }),
    );

    const nested = manifestAt(repo, "ext");

    expect(engineProjectRoot(nested)).toBe(repo);
  });

  it("adopts a root that names Extension.js only as an optional or a peer dependency", () => {
    for (const field of ["optionalDependencies", "peerDependencies"]) {
      const repo = tmp();
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "mono", [field]: { extension: "4.2.0" } }));
      const nested = manifestAt(repo, "ext");

      expect(engineProjectRoot(nested), field).toBe(repo);
      expect(readyContractPath(nested, "chrome"), field).toBe(bridge.readyContractPath(repo, "chrome"));
      expect(projectRootNote(nested), field).toContain(`Project root: ${repo},`);
    }
  });

  it("keeps the folder passed when the manifest is deeper than src and only a stranger's package.json sits above", () => {
    const stranger = tmp();
    fs.writeFileSync(path.join(stranger, "package.json"), JSON.stringify({ name: "stranger" }));
    const project = path.join(stranger, "proj");
    manifestAt(project, "app");

    expect(engineProjectRoot(project)).toBe(project);
    expect(readyContractPath(project, "chrome")).toBe(bridge.readyContractPath(project, "chrome"));
    expect(projectRootNote(project)).toBeNull();
  });

  it("follows a manifest deeper than src to the package.json beside it, below the folder passed", () => {
    const project = tmp();
    const app = manifestAt(project, "app");
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "inner" }));

    expect(engineProjectRoot(project)).toBe(app);
    expect(readyContractPath(project, "chrome")).toBe(bridge.readyContractPath(app, "chrome"));
    expect(projectRootNote(project)).toContain(`Project root: ${app},`);
    expect(storeMdPath(project)).toBe(path.join(app, "STORE.md"));
  });

  it("answers the bundled engine's root in every layout the engine was asked about", () => {
    const M = { manifest_version: 3, name: "x", version: "1.0.0" };
    const EXT = { extension: "4.2.0" };
    const layouts: Array<[Record<string, unknown>, string]> = [
      [{ "src/manifest.json": M }, "."],
      [{ "src/manifest.json": M }, "src"],
      [{ "manifest.json": M }, "."],
      [{ "package.json": { name: "a" }, "src/manifest.json": M }, "."],
      [{ "package.json": { name: "stranger" }, "ext/src/manifest.json": M }, "ext"],
      [{ "package.json": { name: "stranger" }, "ext/manifest.json": M }, "ext"],
      [{ "package.json": { name: "mono", devDependencies: EXT }, "ext/manifest.json": M }, "ext"],
      [{ "app/manifest.json": M }, "."],
      [{ "package.json": { name: "stranger" }, "proj/app/manifest.json": M }, "proj"],
      [{ "package.json": { name: "p" }, "app/manifest.json": M }, "."],
      [{ "app/package.json": { name: "inner" }, "app/manifest.json": M }, "."],
      [{ "package.json": { name: "mono", optionalDependencies: EXT }, "ext/manifest.json": M }, "ext"],
      [{ "package.json": { name: "mono", peerDependencies: EXT }, "ext/manifest.json": M }, "ext"],
      [{ "package.json": { name: "mono" }, "extension.config.js": "export default {}", "ext/manifest.json": M }, "ext"],
      [{ "deno.json": { imports: { extension: "npm:extension@4.2.0" } }, "src/manifest.json": M }, "."],
      [{ "package.json": "{ not json", "src/manifest.json": M }, "."],
      [{ "package.json": '{ // c\n "name":"mono", "devDependencies": {"extension":"4.2.0"} }', "ext/manifest.json": M }, "ext"],
      [{ "package.json": { name: "p" } }, "."],
      [{ "package.json": { name: "mono" }, "packages/one/package.json": { name: "one" }, "packages/one/src/manifest.json": M }, "."],
      [{ "a/manifest.json": M, "b/manifest.json": M }, "."],
    ];

    for (const [files, ask] of layouts) {
      const base = tmp();

      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
        fs.writeFileSync(path.join(base, rel), typeof body === "string" ? body : JSON.stringify(body));
      }

      const asked = path.join(base, ask);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const engine = bridge.resolveSessionProjectRoot(asked);
      warn.mockRestore();
      const said = vi.spyOn(console, "warn");

      expect(path.relative(base, engineProjectRoot(asked)), JSON.stringify(Object.keys(files))).toBe(path.relative(base, engine));
      expect(said, "the read prints nothing").not.toHaveBeenCalled();
      said.mockRestore();
    }
  });
});

describe("a src manifest with no package.json beside it is rooted where the engine that will run builds it", () => {
  const KEYS = ["EXTENSION_MCP_CLI_VERSION", "EXTENSION_MCP_ENGINE_DIR", "EXTENSION_MCP_ENGINE_BIN"];
  const saved = KEYS.map((key) => [key, process.env[key]] as const);

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function bareSrc(): { dir: string; src: string } {
    const dir = tmp();
    const src = path.join(dir, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }));

    return { dir, src };
  }

  function enginePackage(version: string): string {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "extension.cjs"), "");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "extension", version }));

    return dir;
  }

  it("is src under an engine older than 4.2.0 named by EXTENSION_MCP_CLI_VERSION, and says why", () => {
    for (const key of KEYS) delete process.env[key];
    const { dir, src } = bareSrc();

    expect(engineProjectRoot(dir)).toBe(dir);

    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.41";
    expect(engineProjectRoot(dir)).toBe(src);
    expect(readyContractPath(dir, "chrome")).toBe(bridge.readyContractPath(src, "chrome"));
    expect(projectRootNote(dir)).toBe(`Project root: ${src}, the manifest's folder, because the Extension.js that runs here is older than 4.2.0 and no package.json or deno.json sits beside src; dist and zips live there.`);

    for (const current of ["4.2.0", "^4.2.0", "4.3.1", "5.0.0", "canary", "latest"]) {
      process.env.EXTENSION_MCP_CLI_VERSION = current;
      expect(engineProjectRoot(dir), current).toBe(dir);
    }
  });

  it("is src under an older engine override, and the folder passed under a current one, whatever the version variable says", () => {
    for (const key of KEYS) delete process.env[key];
    const { dir, src } = bareSrc();

    process.env.EXTENSION_MCP_ENGINE_DIR = enginePackage("4.1.41");
    expect(engineProjectRoot(dir)).toBe(src);

    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.41";
    process.env.EXTENSION_MCP_ENGINE_DIR = enginePackage("4.2.0");
    expect(engineProjectRoot(dir)).toBe(dir);

    delete process.env.EXTENSION_MCP_ENGINE_DIR;
    process.env.EXTENSION_MCP_ENGINE_BIN = path.join(enginePackage("4.0.9"), "bin", "extension.cjs");
    process.env.EXTENSION_MCP_CLI_VERSION = "4.2.0";
    expect(engineProjectRoot(dir)).toBe(src);
  });

  it.skipIf(process.platform === "win32")("reads the project's own engine before the version variable", () => {
    for (const key of KEYS) delete process.env[key];
    const { dir, src } = bareSrc();
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "extension"));
    fs.writeFileSync(path.join(bin, "extension"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "node_modules", "extension", "package.json"), JSON.stringify({ name: "extension", version: "4.1.41" }));

    process.env.EXTENSION_MCP_CLI_VERSION = "4.2.0";
    expect(engineProjectRoot(dir)).toBe(src);

    fs.writeFileSync(path.join(dir, "node_modules", "extension", "package.json"), JSON.stringify({ name: "extension", version: "4.2.0" }));
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.41";
    expect(engineProjectRoot(dir)).toBe(dir);
  });

  it("leaves every layout the older engine roots the same way where it is", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.EXTENSION_MCP_CLI_VERSION = "4.1.41";

    const owned = tmp();
    fs.writeFileSync(path.join(owned, "package.json"), JSON.stringify({ name: "a" }));
    fs.mkdirSync(path.join(owned, "src"));
    fs.writeFileSync(path.join(owned, "src", "manifest.json"), "{}");
    expect(engineProjectRoot(owned)).toBe(owned);

    const broken = bareSrc();
    fs.writeFileSync(path.join(broken.dir, "package.json"), "{ not json");
    expect(engineProjectRoot(broken.dir)).toBe(broken.src);

    const deno = bareSrc();
    fs.writeFileSync(path.join(deno.dir, "deno.json"), JSON.stringify({ imports: { extension: "npm:extension@4.1.41" } }));
    expect(engineProjectRoot(deno.dir)).toBe(deno.dir);

    const flat = tmp();
    fs.writeFileSync(path.join(flat, "manifest.json"), "{}");
    expect(engineProjectRoot(flat)).toBe(flat);
    expect(engineProjectRoot(broken.src)).toBe(broken.src);
  });
});
