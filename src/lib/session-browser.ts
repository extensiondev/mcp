// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { listSessionMarkers, listSessions } from "./process-manager";

export interface ResolvedBrowser {
  browser: string;
  source: "explicit" | "session" | "contract" | "stale" | "fallback";
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

export interface LiveSession {
  browser: string;
  pid: number;
  source: "registry" | "contract" | "marker";
}

export function liveProjectSessions(projectPath: string): LiveSession[] {
  const resolved = path.resolve(projectPath);
  const out = new Map<string, LiveSession>();
  for (const session of listSessions()) {
    if (path.resolve(session.projectPath) !== resolved) continue;
    if (!pidAlive(session.pid)) continue;
    out.set(session.browser, {
      browser: session.browser,
      pid: session.pid,
      source: "registry",
    });
  }
  for (const sighting of contractSightings(projectPath)) {
    if (sighting.pid === undefined || !pidAlive(sighting.pid)) continue;
    if (out.has(sighting.browser)) continue;
    out.set(sighting.browser, {
      browser: sighting.browser,
      pid: sighting.pid,
      source: "contract",
    });
  }
  for (const marker of listSessionMarkers()) {
    if (path.resolve(marker.projectPath) !== resolved) continue;
    if (out.has(marker.browser)) continue;
    if (typeof marker.pid !== "number" || !pidAlive(marker.pid)) continue;
    out.set(marker.browser, {
      browser: marker.browser,
      pid: marker.pid,
      source: "marker",
    });
  }
  return [...out.values()];
}

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

export interface BrowserExitStamp {
  code?: string;
  browserExitCode?: number | null;
  browserExitedAt?: string;
}

export function browserExitStamp(
  projectPath: string,
  browser: string,
  since: number,
): BrowserExitStamp | null {
  const readyPath = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );
  try {
    const stat = fs.statSync(readyPath);
    if (stat.mtimeMs < since) return null;
    const contract = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    const exited =
      contract?.code === "browser_exited" ||
      contract?.browserExitCode !== undefined ||
      contract?.browserExitedAt !== undefined;
    if (contract?.status === "error" && exited) {
      return {
        code: contract.code,
        browserExitCode: contract.browserExitCode ?? null,
        browserExitedAt: contract.browserExitedAt,
      };
    }
  } catch {
  }
  return null;
}

export function contractBoundPort(
  projectPath: string,
  browser: string,
  since: number,
): number | null {
  const readyPath = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );
  try {
    const stat = fs.statSync(readyPath);
    if (stat.mtimeMs < since) return null;
    const contract = JSON.parse(fs.readFileSync(readyPath, "utf8"));
    return typeof contract?.port === "number" && Number.isFinite(contract.port)
      ? contract.port
      : null;
  } catch {
    return null;
  }
}

export function resolveSessionBrowser(
  projectPath: string,
  explicit: string | undefined,
  fallback = "chrome",
): ResolvedBrowser {
  if (explicit) return { browser: explicit, source: "explicit" };

  const resolved = path.resolve(projectPath);
  const mine = listSessions().filter(
    (s) => path.resolve(s.projectPath) === resolved,
  );
  if (mine.length > 0) {
    return { browser: mine[mine.length - 1].browser, source: "session" };
  }

  const sightings = contractSightings(projectPath).sort(
    (a, b) => b.mtimeMs - a.mtimeMs,
  );
  const live = sightings.filter((s) => s.pid === undefined || pidAlive(s.pid));
  if (live.length > 0) {
    return { browser: live[0].browser, source: "contract" };
  }

  if (sightings.length > 0) {
    return { browser: sightings[0].browser, source: "stale" };
  }

  return { browser: fallback, source: "fallback" };
}
