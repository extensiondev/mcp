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

import { directoryNotCreatedYet, sessionStateDir } from "./process-manager";

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

export function forgetCarrier(projectPath: string): void {
  const resolved = path.resolve(projectPath);

  try {
    fs.rmSync(recordPath(resolved), { force: true });
  } catch {
  }
}

export function readRememberedCarriers(): { carriers: string[]; unreadable: string | null } {
  let files: string[];

  try {
    files = fs.readdirSync(recordDir());
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const absent = code === "ENOENT" && directoryNotCreatedYet(recordDir());

    return {
      carriers: [],
      unreadable: absent ? null : `${recordDir()}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const out: string[] = [];
  const torn: string[] = [];

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
      torn.push(file);
    }
  }

  return {
    carriers: out,
    unreadable: torn.length ? `${torn.length} carrier record${torn.length === 1 ? "" : "s"} under ${recordDir()} could not be parsed (${torn.slice(0, 3).join(", ")})` : null,
  };
}

