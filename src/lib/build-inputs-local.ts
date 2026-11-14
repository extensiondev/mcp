// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";

import { isBuildInput, type PackageHold } from "./build-inputs";

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
