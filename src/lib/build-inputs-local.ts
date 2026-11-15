// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";

import { PACKAGE_HOLD_WINDOW, isBuildInput, type PackageHold, type PackageHoldFact } from "./build-inputs";

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

/* @invariant THE HOLD CROSSES THE LANE AS WHAT THIS MACHINE'S REPOSITORY
 * PROVES, BEFORE THE LANE NAMES A BUILD. The hosted half learns which builds
 * the package checks read only after it asks the platform, and it holds no
 * repository, so the forwarder sends the proof for every build it could
 * name: each of the newest commits behind HEAD whose diff to HEAD is not
 * empty and touches no file a build reads, with the files that changed. The
 * lane picks the entry of the build it read; a build further behind HEAD
 * than the window is not held and is answered the way a build with no proof
 * is.
 */
export function localPackageHolds(projectPath: string, head: string): PackageHoldFact | null {
  if (!projectPath || !head) return null;

  const listed = git(projectPath, ["rev-list", `--max-count=${PACKAGE_HOLD_WINDOW + 1}`, head]);
  if (listed === null) return null;

  const behind = listed
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((commit) => commit && commit !== head);
  const held: PackageHold[] = [];

  for (const build of behind) {
    const hold = localPackageHold(projectPath, [build], head);
    if (hold) held.push(hold);
  }

  return { head, held };
}
