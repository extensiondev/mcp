import fs from "node:fs";
import path from "node:path";
import { listSessions } from "./process-manager";

// Session-aware browser defaulting (fresh-eyes walk, friction #1).
//
// The act tools used to hard-default `browser` to "chromium" while
// `extension_dev` defaults to "chrome" — so an agent that started a session
// with one browser and omitted `browser` on the next call was told "no active
// control channel", and an obedient agent would spawn a second, conflicting
// session. The default must be THE SESSION THAT IS RUNNING, not a constant.
//
// Resolution order:
// 1. explicit — the caller said which browser; never second-guess it.
// 2. session — the in-memory registry of dev/start/preview processes this
//    MCP server spawned (most recently registered wins).
// 3. contract — dist/extension-js/<browser>/ready.json files on disk. Covers
//    sessions started before an MCP restart or from a terminal. Freshest
//    contract wins; entries whose pid is dead are ignored.
// 4. fallback — the tool's historical default, so behavior without any
//    session is unchanged.

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
      // No contract in this dir, or mid-write — skip it.
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

/** Browsers with a live session for this project (registry + disk contracts). */
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
