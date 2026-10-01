import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as bridge from "extension-develop/bridge";

import {
  engineProjectRoot,
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
