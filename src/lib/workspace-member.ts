// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { dropTrailing } from "./linear-text";

/* @invariant WHERE A PROJECT'S DEPENDENCIES LIVE IS READ THE WAY THE ENGINE
 * READS IT. Extension.js installs a workspace member from its workspace
 * root, with the root's package manager, and reads a member whose packages
 * are hoisted to the root as installed (extension.js
 * programs/develop/lib/package-manager.ts and paths.ts needsInstall, read at
 * v4.2.0). This file is that reading and nothing else: the nearest
 * pnpm-workspace.yaml or package.json "workspaces" list at or above the
 * project, never past the project's own .git, whose patterns name the
 * project's folder; the manager from the lockfile beside it, then from the
 * packageManager field; and the names a package.json or a deno.json(c)
 * declares. A server that read only the project's own folder took the
 * install record for every build of a hoisted member, skipped it for a
 * node_modules that held nothing the project declares, and ran npm inside a
 * pnpm workspace.
 */

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface WorkspaceMember {
  root: string;
  relativeDir: string;
  manager: PackageManager;
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

function readText(file: string): string {
  const text = fs.readFileSync(file, "utf8");

  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readText(file));

    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function lockfileManager(dir: string): PackageManager | null {
  return LOCKFILES.find(([name]) => fs.existsSync(path.join(dir, name)))?.[1] ?? null;
}

export function pinnedManager(dir: string): PackageManager | null {
  const pinned = /^(npm|pnpm|yarn|bun)@/.exec(String(readJson(path.join(dir, "package.json"))?.packageManager ?? "").trim());

  return pinned ? (pinned[1] as PackageManager) : null;
}

function workspacePatterns(dir: string): string[] | null {
  const field = readJson(path.join(dir, "package.json"))?.workspaces;
  const list = Array.isArray(field) ? field : (field as { packages?: unknown } | undefined)?.packages;

  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : null;
}

function nearestAtOrAbove(start: string, marks: (dir: string) => boolean): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (marks(dir)) return dir;
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return null;
  }
}

function listItem(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*?)\1/.exec(trimmed);

  return quoted ? quoted[2].trim() : trimmed.replace(/\s+#.*$/, "").trim();
}

function pnpmPatterns(root: string): string[] {
  let lines: string[];

  try {
    lines = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }

  const at = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (at === -1) return [];

  const inline = lines[at].replace(/^packages\s*:/, "").trim();

  if (inline.startsWith("[")) {
    let flow = inline;

    for (let next = at + 1; !flow.includes("]") && next < lines.length; next += 1) flow += lines[next];

    return flow.slice(1, flow.includes("]") ? flow.indexOf("]") : undefined).split(",").map(listItem).filter(Boolean);
  }

  const patterns: string[] = [];

  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) break;

    patterns.push(listItem(item[1]));
  }

  return patterns.filter(Boolean);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at];

    if (char === "*" && pattern[at + 1] === "*") {
      const spansSegments = pattern[at + 2] === "/";
      source += spansSegments ? "(?:.*/)?" : ".*";
      at += spansSegments ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`${source}$`);
}

function namedBy(patterns: string[], relativeDir: string): boolean {
  let included = false;

  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const glob = dropTrailing((negated ? raw.slice(1) : raw).replace(/^\.\//, ""), "/");

    if (!globToRegExp(glob).test(relativeDir)) continue;
    if (negated) return false;

    included = true;
  }

  return included;
}

function memberOf(root: string | null, projectDir: string, patterns: (root: string) => string[]): { root: string; relativeDir: string } | null {
  const project = path.resolve(projectDir);
  if (!root || root === project) return null;

  const relativeDir = path.relative(root, project).split(path.sep).join("/");

  return namedBy(patterns(root), relativeDir) ? { root, relativeDir } : null;
}

export function findWorkspaceMember(projectDir: string): WorkspaceMember | null {
  const ofPnpm = memberOf(
    nearestAtOrAbove(projectDir, (dir) => fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))),
    projectDir,
    pnpmPatterns,
  );
  if (ofPnpm) return { ...ofPnpm, manager: "pnpm" };

  const ofPackageJson = memberOf(
    nearestAtOrAbove(projectDir, (dir) => workspacePatterns(dir) !== null),
    projectDir,
    (root) => workspacePatterns(root) ?? [],
  );
  if (!ofPackageJson) return null;

  const locked = lockfileManager(ofPackageJson.root);
  if (locked === "pnpm") return null;

  const pinned = pinnedManager(ofPackageJson.root);

  return { ...ofPackageJson, manager: locked ?? (pinned && pinned !== "pnpm" ? pinned : "npm") };
}

export function isWorkspaceOrRepositoryRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) || workspacePatterns(dir) !== null;
}

function withoutJsonComments(text: string): string {
  let out = "";
  let inString = false;

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];

    if (inString) {
      out += char;
      if (char === "\\") out += text[(at += 1)] ?? "";
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
      out += char;
    } else if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at += 1;
    } else if (char === "/" && text[at + 1] === "*") {
      at = text.indexOf("*/", at + 2) === -1 ? text.length : text.indexOf("*/", at + 2) + 1;
    } else {
      out += char;
    }
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}

function npmSpecifierName(specifier: unknown): string | null {
  if (typeof specifier !== "string" || !specifier.startsWith("npm:")) return null;

  const rest = specifier.slice(4).replace(/^\//, "");
  const versionAt = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
  const name = versionAt === -1 ? rest.split("/", rest.startsWith("@") ? 2 : 1).join("/") : rest.slice(0, versionAt);

  return name || null;
}

function denoDependencyNames(projectDir: string): string[] {
  for (const filename of ["deno.jsonc", "deno.json"]) {
    let imports: unknown;

    try {
      imports = (JSON.parse(withoutJsonComments(readText(path.join(projectDir, filename))).trim() || "{}") as { imports?: unknown }).imports;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;

      return [];
    }

    if (!imports || typeof imports !== "object") return [];

    return Object.entries(imports).flatMap(([alias, specifier]) => {
      const name = npmSpecifierName(specifier);

      return name ? [name, alias.replace(/\/$/, "")].filter(Boolean) : [];
    });
  }

  return [];
}

export function declaredDependencyNames(projectDir: string): string[] {
  const manifest = readJson(path.join(projectDir, "package.json")) ?? {};
  const fromPackageJson = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((field) => {
    const section = manifest[field];

    return section && typeof section === "object" ? Object.entries(section).filter(([, version]) => typeof version === "string").map(([name]) => name) : [];
  });

  return [...new Set([...denoDependencyNames(projectDir), ...fromPackageJson])];
}
