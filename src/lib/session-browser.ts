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
import { pidState } from "./process-identity";
import {
  readyContractPath,
  sessionArtifactsRootDir,
} from "./session-paths";

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
  const root = sessionArtifactsRootDir(projectPath);
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const sightings: ContractSighting[] = [];
  for (const dir of dirs) {
    const readyPath = readyContractPath(projectPath, dir);
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

/* A recorded pid counts only while it is alive AND still a session process;
   a number reused by a stranger reads as gone. */
function pidAlive(pid: number): boolean {
  return pidState(pid) === "alive";
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
  browser?: string,
): { browser: string; pid: number } | null {
  for (const sighting of contractSightings(projectPath)) {
    if (browser && sighting.browser !== browser) continue;
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
  const readyPath = readyContractPath(projectPath, browser);
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
  const readyPath = readyContractPath(projectPath, browser);
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

/* @invariant THE CONTROL CHANNEL IS REPORTED FROM THE CONTRACT. A control
   server that cannot bind leaves controlPort null and
   controlPortUnavailableReason in ready.json. */
export function contractControlState(
  projectPath: string,
  browser: string,
  since: number,
): { read: boolean; port: number | null; unavailableReason: string | null } {
  try {
    const file = readyContractPath(projectPath, browser);
    if (fs.statSync(file).mtimeMs < since) return { read: false, port: null, unavailableReason: null };
    const contract = JSON.parse(fs.readFileSync(file, "utf8")) as {
      controlPort?: unknown;
      controlPortUnavailableReason?: unknown;
    };
    return {
      read: true,
      port: typeof contract.controlPort === "number" ? contract.controlPort : null,
      unavailableReason:
        typeof contract.controlPortUnavailableReason === "string" && contract.controlPortUnavailableReason
          ? contract.controlPortUnavailableReason
          : null,
    };
  } catch {
    return { read: false, port: null, unavailableReason: null };
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
