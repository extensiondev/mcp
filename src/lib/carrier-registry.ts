// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sessionStateDir } from "./process-manager";

const placedHere = new Set<string>();

function recordDir(): string {
  return path.join(sessionStateDir(), "carriers");
}

function recordPath(resolved: string): string {
  const digest = crypto
    .createHash("sha1")
    .update(resolved)
    .digest("hex")
    .slice(0, 16);
  return path.join(recordDir(), `${digest}.json`);
}

/* @invariant
 * A placed carrier is written down before anything is asked to remove it.
 *
 * Removal used to be reachable only through a session: extension_stop walks
 * the sessions this server registered plus the markers on disk, so a project
 * whose session record was already gone, or whose carrier was placed by an
 * MCP server that has since been replaced, had nothing left pointing at it and
 * kept a debug companion with <all_urls> in its auto-loaded ./extensions
 * folder forever. This record is the second pointer, and it is deliberately
 * kept beside the session markers rather than in the project, so a project
 * that is never opened again is still reachable from the machine.
 */
export function rememberCarrier(projectPath: string): void {
  const resolved = path.resolve(projectPath);
  placedHere.add(resolved);
  try {
    fs.mkdirSync(recordDir(), { recursive: true });
    fs.writeFileSync(
      recordPath(resolved),
      `${JSON.stringify({
        projectPath: resolved,
        pid: process.pid,
        placedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch {
  }
}

export function forgetCarrier(projectPath: string): void {
  const resolved = path.resolve(projectPath);
  placedHere.delete(resolved);
  try {
    fs.rmSync(recordPath(resolved), { force: true });
  } catch {
  }
}

export function carriersPlacedHere(): string[] {
  return [...placedHere];
}

export function rememberedCarriers(): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(recordDir());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(recordDir(), file), "utf8"),
      ) as { projectPath?: unknown };
      if (typeof parsed.projectPath === "string" && parsed.projectPath) {
        out.push(parsed.projectPath);
      }
    } catch {
    }
  }
  return out;
}
