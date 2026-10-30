// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ENGINE_DIR_ENV = "EXTENSION_MCP_ENGINE_DIR";
export const ENGINE_BIN_ENV = "EXTENSION_MCP_ENGINE_BIN";

const BIN_UNDER_PACKAGE = path.join("bin", "extension.cjs");
const PACKAGE_UNDER_CHECKOUT = path.join("programs", "extension");

export interface EngineOverride {
  env: string;
  given: string;
  bin: string | null;
  expectedBin: string;
  packageDir: string | null;
  expected: string;
}

export interface GitFacts {
  sha: string;
  branch: string | null;
}

export interface LocalEngineFacts {
  version: string | null;
  git: GitFacts | null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function fromDir(given: string): EngineOverride {
  const dir = path.resolve(given);
  const checkoutBin = path.join(dir, PACKAGE_UNDER_CHECKOUT, BIN_UNDER_PACKAGE);
  const packageBin = path.join(dir, BIN_UNDER_PACKAGE);
  const expected = `${checkoutBin} (an Extension.js checkout root, compiled) or ${packageBin} (a built extension package)`;

  if (isFile(checkoutBin)) {
    return { env: ENGINE_DIR_ENV, given, bin: checkoutBin, expectedBin: checkoutBin, packageDir: path.join(dir, PACKAGE_UNDER_CHECKOUT), expected };
  }

  if (isFile(packageBin)) {
    return { env: ENGINE_DIR_ENV, given, bin: packageBin, expectedBin: packageBin, packageDir: dir, expected };
  }

  return { env: ENGINE_DIR_ENV, given, bin: null, expectedBin: checkoutBin, packageDir: null, expected };
}

function fromBin(given: string): EngineOverride {
  const bin = path.resolve(given);
  const expected = `${bin} to be the engine's bin/extension.cjs file`;

  if (isFile(bin)) {
    return { env: ENGINE_BIN_ENV, given, bin, expectedBin: bin, packageDir: path.dirname(path.dirname(bin)), expected };
  }

  return { env: ENGINE_BIN_ENV, given, bin: null, expectedBin: bin, packageDir: null, expected };
}

export function resolveEngineOverride(
  env: NodeJS.ProcessEnv = process.env,
): EngineOverride | null {
  const dir = String(env[ENGINE_DIR_ENV] || "").trim();
  if (dir) return fromDir(dir);

  const bin = String(env[ENGINE_BIN_ENV] || "").trim();
  if (bin) return fromBin(bin);

  return null;
}

export function engineOverrideRefusal(override: EngineOverride): string {
  return `${override.env}=${override.given} names no engine bin: expected ${override.expected}. Fix the path or unset ${override.env}; no engine was spawned and nothing fell back to the project's engine or the MCP pin.`;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 3_000,
  }).trim();
}

export function insideNodeModules(dir: string): boolean {
  return path.resolve(dir).split(path.sep).includes("node_modules");
}

export function readGitFacts(dir: string): GitFacts | null {
  if (insideNodeModules(dir)) return null;

  try {
    const sha = git(dir, ["rev-parse", "--short", "HEAD"]);
    if (!sha) return null;

    const branch = git(dir, ["branch", "--show-current"]);

    return { sha, branch: branch || null };
  } catch {
    return null;
  }
}

export function readPackageVersion(packageDir: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
    ) as { version?: unknown };

    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function readLocalEngineFacts(packageDir: string): LocalEngineFacts {
  return { version: readPackageVersion(packageDir), git: readGitFacts(packageDir) };
}

export function localEngineSentence(facts: LocalEngineFacts): string {
  const version = `extension@${facts.version ?? "unknown"}`;
  if (!facts.git) return version;

  return `${version}, ${facts.git.sha} ${facts.git.branch ? `on ${facts.git.branch}` : "detached"}`;
}

export function describeEngineOverride(override: EngineOverride): string {
  if (!override.bin || !override.packageDir) return engineOverrideRefusal(override);

  const facts = localEngineSentence(readLocalEngineFacts(override.packageDir));

  return `${process.execPath} ${override.bin} (the engine override ${override.env}=${override.given}: ${facts}; the project's engine and this server's pin are bypassed)`;
}
