// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { userCacheDir } from "../lib/user-cache-dir";
import { ARTIFACTS_DIR, type DownloadLocal } from "./builds-download";

/* @invariant A READ NEVER DIRTIES THE OWNER'S REPOSITORY. The package a
 * download saves is a copy of what the platform holds, so by default it
 * lands in the user's cache directory, keyed by workspace, project and
 * build, and never under the project: the first version wrote it to
 * .extension.dev/artifacts/ inside the project and appended that folder to
 * the project's .gitignore, which left a tracked file modified after a
 * read-only ask (ledger 249). Only an explicit `to` writes anywhere else,
 * and no path this action takes touches .gitignore.
 */
export function defaultArtifactsDir(workspace: string, project: string, buildId: string): string {
  return path.join(userCacheDir(), ARTIFACTS_DIR, workspace, project, buildId);
}

function explicitTarget(to: string, projectPath: string): string {
  if (!to) return "";

  return path.isAbsolute(to) ? path.resolve(to) : path.resolve(projectPath || process.cwd(), to);
}

export const BUILDS_DOWNLOAD_LOCAL: DownloadLocal = {
  explicitTarget,
  defaultArtifactsDir,
  save(dir, filePath, bytes) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, bytes);
  },
  readBack: (filePath) => fs.readFileSync(filePath),
};
