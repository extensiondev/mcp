// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";

const DOCS_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const NOTICE_FILE = /^(licen[cs]es?|notice|copying|third_party_notices)(-[\w-]*)?(\.(txt|md|markdown))?$/i;
const PACKAGED_DIRECTORY = "public";
const NAMED_FILES = 3;

export interface PackageHold {
  build: string;
  changed: string[];
}

export function isBuildInput(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return true;
  if (segments.includes(PACKAGED_DIRECTORY)) return true;

  const name = segments[segments.length - 1]!;
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (DOCS_EXTENSIONS.has(extension)) return false;

  return !NOTICE_FILE.test(name);
}

function git(projectPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export function localPackageHold(projectPath: string, builds: string[], head: string): PackageHold | null {
  if (!projectPath || !head) return null;

  for (const build of builds) {
    if (git(projectPath, ["merge-base", "--is-ancestor", build, head]) === null) continue;

    const diff = git(projectPath, ["diff", "--name-only", "--no-renames", build, head]);
    if (diff === null) continue;

    const changed = diff
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!changed.length || changed.some(isBuildInput)) continue;

    return { build, changed };
  }

  return null;
}

export function packageHoldSentence(hold: PackageHold, subject: string): string {
  const named = hold.changed.slice(0, NAMED_FILES).join(", ");
  const more = hold.changed.length - NAMED_FILES;
  const list = more > 0 ? `${named} and ${more} more file${more === 1 ? "" : "s"}` : named;

  return `${subject} changes only ${list}, which the build does not read, so the package checks still hold for build ${hold.build} and no push is needed`;
}
