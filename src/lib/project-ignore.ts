// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

export type ProjectIgnoreState =
  | "added"
  | "already-ignored"
  | "not-a-repo"
  | "failed";

export interface ProjectIgnoreOutcome {
  state: ProjectIgnoreState;
  entry: string;
}

/* @invariant
 * Being inside a repository is what matters, not being its root.
 *
 * This used to require a .git entry in the project directory itself, so any
 * project that is a package inside a larger repository counted as "not a
 * repo" and got no ignore rule at all. The carrier is a 380KB extension
 * carrying <all_urls>, cookies, history and management, and the tool
 * description promises it is gitignored, so in a monorepo the next `git add
 * -A` at the root committed exactly what the promise said it would not. A
 * .gitignore written in the project directory is honoured by git no matter how
 * deep it sits, so the fix is to look upward for the repository rather than to
 * write the file somewhere else.
 */
function insideRepository(projectPath: string): boolean {
  let current = path.resolve(projectPath);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function ensureProjectIgnored(
  projectPath: string,
  options: { entry: string; aliases?: string[]; comment: string },
): ProjectIgnoreOutcome {
  const entry = options.entry;
  if (!insideRepository(projectPath)) {
    return { state: "not-a-repo", entry };
  }
  const file = path.join(projectPath, ".gitignore");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf-8");
  } catch {
  }
  const known = new Set([entry, ...(options.aliases ?? [])]);
  const ignored = current
    .split("\n")
    .map((line) => line.trim())
    .some((line) => known.has(line));
  if (ignored) return { state: "already-ignored", entry };
  try {
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, `${prefix}\n${options.comment}\n${entry}\n`);
    return { state: "added", entry };
  } catch {
    return { state: "failed", entry };
  }
}
