// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { listSessions } from "./process-manager";

export interface ResolvedBrowser {
  browser: string;
  source: "explicit" | "session" | "contract" | "fallback";
}

interface ContractSighting {
  browser: string;
  mtimeMs: number;
  pid?: number;
}

function contractSightings(projectPath: string): ContractSighting[] {
  const root = path.resolve(projectPath, "dist", "extension-js");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const sightings: ContractSighting[] = [];
  for (const dir of dirs) {
    const readyPath = path.join(root, dir, "ready.json");
    try {
      const stat = fs.statSync(readyPath);
      const contract = JSON.parse(fs.readFileSync(readyPath, "utf8"));
      if (contract?.status !== "ready") continue;
      sightings.push({
        browser: dir,
        mtimeMs: stat.mtimeMs,
        pid: typeof contract.pid === "number" ? contract.pid : undefined,
      });
    } catch {
    }
  }
  return sightings;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function knownSessionBrowsers(projectPath: string): string[] {
  const resolved = path.resolve(projectPath);
  const browsers: string[] = [];
  for (const session of listSessions()) {
    if (path.resolve(session.projectPath) === resolved) {
      browsers.push(session.browser);
    }
  }
  for (const sighting of contractSightings(projectPath)) {
    if (sighting.pid !== undefined && !pidAlive(sighting.pid)) continue;
    browsers.push(sighting.browser);
  }
  return Array.from(new Set(browsers));
}

// A ready.json that says "ready" but whose pid is dead means the dev server
// exited — the real cause behind most "control channel refused (1006)" errors,
// which otherwise misleadingly ask "is the session started with allowControl?".
export function deadReadySession(
  projectPath: string,
): { browser: string; pid: number } | null {
  for (const sighting of contractSightings(projectPath)) {
    if (sighting.pid !== undefined && !pidAlive(sighting.pid)) {
      return { browser: sighting.browser, pid: sighting.pid };
    }
  }
  return null;
}

export function resolveSessionBrowser(
  projectPath: string,
  explicit: string | undefined,
  fallback = "chromium",
): ResolvedBrowser {
  if (explicit) return { browser: explicit, source: "explicit" };

  const resolved = path.resolve(projectPath);
  const mine = listSessions().filter(
    (s) => path.resolve(s.projectPath) === resolved,
  );
  if (mine.length > 0) {
    return { browser: mine[mine.length - 1].browser, source: "session" };
  }

  const sightings = contractSightings(projectPath)
    .filter((s) => s.pid === undefined || pidAlive(s.pid))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (sightings.length > 0) {
    return { browser: sightings[0].browser, source: "contract" };
  }

  return { browser: fallback, source: "fallback" };
}
