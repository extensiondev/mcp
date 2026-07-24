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

export function ensureProjectIgnored(
  projectPath: string,
  options: { entry: string; aliases?: string[]; comment: string },
): ProjectIgnoreOutcome {
  const entry = options.entry;
  if (!fs.existsSync(path.join(projectPath, ".git"))) {
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
