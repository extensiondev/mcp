import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";
import * as bridge from "extension-develop/bridge";

import {
  engineProjectRoot,
  ownsManifest,
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
  it("walks up from a manifest subfolder to the package root", () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    const sub = path.join(repo, "Extensions", "combined");
    fs.mkdirSync(sub, { recursive: true });

    expect(engineProjectRoot(sub)).toBe(repo);
    expect(readyContractPath(sub, "chrome")).toBe(bridge.readyContractPath(repo, "chrome"));
    expect(logsPath(sub, "firefox")).toBe(bridge.logsPath(repo, "firefox"));
    expect(sessionArtifactsRootDir(sub)).toBe(bridge.sessionArtifactsRootDir(repo));
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
    expect(ownsManifest(path.join(stranger, "package.json"), path.join(inner, "manifest.json"))).toBe(false);
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
});
