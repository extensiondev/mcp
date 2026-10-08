// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { engineProjectRoot } from "./session-paths";

export interface ScaffoldScript {
  name: string;
  run: string;
  command: string;
  browser: string;
  writes: string | null;
}

const ENGINE_FLAGLESS_BROWSER = "chromium";
const ENGINE_VERBS = new Set(["dev", "start", "build", "preview"]);
const VERBS_THAT_WRITE_DIST = new Set(["dev", "start", "build"]);

function unquoted(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

function engineVerbIndex(parts: string[]): number {
  for (let i = 1; i < parts.length; i += 1) {
    const binary = unquoted(parts[i - 1]!);
    const runsTheEngine = binary === "extension" || binary.endsWith("/extension") || binary.endsWith("cli.cjs");
    if (runsTheEngine && ENGINE_VERBS.has(parts[i]!)) return i;
  }

  return -1;
}

function browserFlag(parts: string[]): string | null {
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i]!;
    if (token.startsWith("--browser=")) return token.slice("--browser=".length);
    if ((token === "--browser" || token === "-b") && parts[i + 1]) return parts[i + 1]!;
  }

  return null;
}

function readScripts(projectPath: string): Array<[string, string]> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts !== "object") return [];

    return Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
  } catch {
    return [];
  }
}

export function scaffoldScripts(projectPath: string, packageManager: string): ScaffoldScript[] {
  const out: ScaffoldScript[] = [];

  for (const [name, command] of readScripts(projectPath)) {
    const parts = command.trim().split(/\s+/).filter(Boolean);
    const at = engineVerbIndex(parts);
    if (at < 0) continue;

    const verb = parts[at]!;
    const next = parts[at + 1];
    const target = next && !next.startsWith("-") ? unquoted(next) : ".";
    const browser = browserFlag(parts.slice(at + 1)) ?? ENGINE_FLAGLESS_BROWSER;
    const root = engineProjectRoot(path.resolve(projectPath, target));
    const writes = VERBS_THAT_WRITE_DIST.has(verb)
      ? path.relative(projectPath, path.join(root, "dist", browser)).split(path.sep).join("/")
      : null;

    out.push({ name, run: `${packageManager} run ${name}`, command, browser, writes });
  }

  return out;
}
