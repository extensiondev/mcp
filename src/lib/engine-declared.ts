// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { compareVersions, decompose } from "./engine-version";

export type DeclaredEngine = { kind: "declared"; spec: string } | { kind: "none" } | { kind: "unreadable" };

export type DeclaredMatch = "match" | "drift" | "unparsed" | "spec";

const SPEC_PREFIXES = ["workspace:", "file:", "link:", "npm:", "git+", "git:", "github:", "gitlab:", "bitbucket:", "http:", "https:"];

const LOCKFILES: Array<[string, string]> = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
];

export function readDeclaredEngine(projectPath: string): DeclaredEngine {
  let parsed: { dependencies?: unknown; devDependencies?: unknown };

  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8")) as typeof parsed;
  } catch {
    return { kind: "unreadable" };
  }

  for (const block of [parsed.dependencies, parsed.devDependencies]) {
    if (!block || typeof block !== "object") continue;

    const spec = (block as Record<string, unknown>).extension;
    if (typeof spec === "string" && spec.trim()) return { kind: "declared", spec: spec.trim() };
  }

  return { kind: "none" };
}

function isSpecWithoutVersion(spec: string): boolean {
  return spec === "latest" || SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix)) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec);
}

function withinRange(installed: string, base: string, bound: "caret" | "tilde"): boolean {
  const left = decompose(installed);
  const right = decompose(base);
  if (!left || !right) return false;

  const ordering = compareVersions(installed, base);
  if (ordering === null || ordering < 0) return false;

  const sameTuple = left.release.every((part, index) => part === right.release[index]);
  if (left.prerelease.length && !sameTuple) return false;

  const [major, minor] = right.release;

  if (bound === "tilde" || major === 0) {
    if (left.release[0] !== major || left.release[1] !== minor) return false;

    return major !== 0 || minor !== 0 || left.release[2] === right.release[2];
  }

  return left.release[0] === major;
}

export function declaredMatch(spec: string, installed: string): DeclaredMatch {
  if (isSpecWithoutVersion(spec)) return "spec";

  const bound = spec.startsWith("^") ? "caret" : spec.startsWith("~") ? "tilde" : null;
  const base = bound ? spec.slice(1).trim() : spec.replace(/^=/, "").trim();
  if (!decompose(base) || !decompose(installed)) return "unparsed";

  if (!bound) return compareVersions(installed, base) === 0 ? "match" : "drift";

  return withinRange(installed, base, bound) ? "match" : "drift";
}

export function installCommand(projectPath: string): string {
  for (const [lockfile, command] of LOCKFILES) {
    if (fs.existsSync(path.join(projectPath, lockfile))) return command;
  }

  return "npm install";
}

export interface DeclaredRead {
  declared: string | null;
  sentence: string | null;
  drifted: boolean;
}

export function readDeclaredDrift(projectPath: string, installed: string): DeclaredRead {
  const read = readDeclaredEngine(projectPath);

  if (read.kind === "unreadable") return { declared: null, sentence: null, drifted: false };

  if (read.kind === "none") {
    return { declared: null, sentence: "package.json declares no extension dependency", drifted: false };
  }

  const match = declaredMatch(read.spec, installed);

  switch (match) {
    case "match":
      return { declared: read.spec, sentence: null, drifted: false };
    case "spec":
      return { declared: read.spec, sentence: `package.json declares extension as ${read.spec}`, drifted: false };
    case "unparsed":
      return {
        declared: read.spec,
        sentence: `package.json declares extension@${read.spec}, which could not be compared with the installed extension@${installed}`,
        drifted: false,
      };
    default:
      return {
        declared: read.spec,
        sentence: `package.json pins extension@${read.spec}, node_modules has extension@${installed}; the project's own build and tests run on the installed copy; run npm install (or pnpm install) to match`,
        drifted: true,
      };
  }
}

export function driftRemediation(projectPath: string, declared: string): string {
  return `Run \`(cd ${projectPath} && ${installCommand(projectPath)})\` so node_modules/extension matches the package.json pin extension@${declared}.`;
}
