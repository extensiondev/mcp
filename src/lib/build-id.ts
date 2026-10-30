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

export interface BuildFacts {
  version: string;
  headSha: string;
  tagsAtHead: string[];
  headSubject: string;
  committedVersion: string | null;
}

export function buildIdFor(facts: BuildFacts): string {
  const { version, headSha } = facts;
  if (!headSha) return "";
  if (/[-+]/.test(version)) return "";
  if (facts.committedVersion !== null && facts.committedVersion !== version) return "";
  if (facts.tagsAtHead.includes(`v${version}`)) return "";
  if (facts.headSubject.trim() === `Release v${version}`) return "";

  return headSha;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
}

function committedVersionOf(root: string): string | null {
  try {
    const parsed = JSON.parse(git(root, ["show", "HEAD:package.json"])) as { version?: unknown };

    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function readBuildId(root: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    const version = typeof manifest.version === "string" ? manifest.version : "";
    if (!version) return "";

    return buildIdFor({
      version,
      headSha: git(root, ["rev-parse", "--short", "HEAD"]),
      tagsAtHead: git(root, ["tag", "--points-at", "HEAD"]).split("\n").map((tag) => tag.trim()).filter(Boolean),
      headSubject: git(root, ["log", "-1", "--format=%s", "HEAD"]),
      committedVersion: committedVersionOf(root),
    });
  } catch {
    return "";
  }
}

export function producerVersion(version: string, buildId: string): string {
  return buildId ? `${version}+${buildId}` : version;
}
