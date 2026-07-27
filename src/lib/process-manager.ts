// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProcessInfo } from "./types";

const sessions = new Map<string, ProcessInfo>();
const registrationStamps = new Map<string, { pid: number; at: number }>();

function sessionKey(projectPath: string, browser: string): string {
  return `${path.resolve(projectPath)}::${browser}`;
}

function markerDir(): string {
  return (
    process.env.EXTENSION_MCP_SESSION_DIR ||
    path.join(os.tmpdir(), "extension-dev-mcp-sessions")
  );
}

function markerPath(projectPath: string, browser: string): string {
  const digest = crypto
    .createHash("sha1")
    .update(sessionKey(projectPath, browser))
    .digest("hex")
    .slice(0, 16);
  return path.join(markerDir(), `${digest}.json`);
}

export function removeSessionMarker(
  projectPath: string,
  browser: string,
  pid?: number,
): void {
  const file = markerPath(projectPath, browser);
  if (pid !== undefined) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed?.pid === "number" && parsed.pid !== pid) return;
    } catch {
    }
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
  }
}

export function listSessionMarkers(): ProcessInfo[] {
  let files: string[];
  try {
    files = fs.readdirSync(markerDir());
  } catch {
    return [];
  }
  const out: ProcessInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(markerDir(), file), "utf8"),
      );
      if (
        typeof parsed?.projectPath === "string" &&
        typeof parsed?.browser === "string"
      ) {
        out.push(parsed as ProcessInfo);
      }
    } catch {
    }
  }
  return out;
}

function writeMarkerBestEffort(info: ProcessInfo, registeredAtMs: number): void {
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(
      markerPath(info.projectPath, info.browser),
      JSON.stringify({
        ...info,
        projectPath: path.resolve(info.projectPath),
        registeredAt: new Date(registeredAtMs).toISOString(),
      }),
    );
  } catch {
  }
}

export function registerSession(info: ProcessInfo): void {
  const key = sessionKey(info.projectPath, info.browser);
  const prior = registrationStamps.get(key);
  const at = prior && prior.pid === info.pid ? prior.at : Date.now();
  registrationStamps.set(key, { pid: info.pid, at });
  sessions.set(key, info);
  writeMarkerBestEffort(info, at);
}

export function sessionSinceMs(
  projectPath: string,
  browser: string,
): number | null {
  const stamp = registrationStamps.get(sessionKey(projectPath, browser));
  if (stamp) return stamp.at;
  const resolved = path.resolve(projectPath);
  for (const marker of listSessionMarkers()) {
    if (
      path.resolve(marker.projectPath) !== resolved ||
      marker.browser !== browser
    ) {
      continue;
    }
    const registeredAt = (marker as ProcessInfo & { registeredAt?: string })
      .registeredAt;
    if (typeof registeredAt === "string") {
      const parsed = Date.parse(registeredAt);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function getSession(
  projectPath: string,
  browser: string,
): ProcessInfo | undefined {
  return sessions.get(sessionKey(projectPath, browser));
}

export function findSessionInfo(
  projectPath: string,
  browser: string,
): ProcessInfo | undefined {
  const inMemory = sessions.get(sessionKey(projectPath, browser));
  if (inMemory) return inMemory;
  const resolved = path.resolve(projectPath);
  for (const marker of listSessionMarkers()) {
    if (
      path.resolve(marker.projectPath) === resolved &&
      marker.browser === browser
    ) {
      return marker;
    }
  }
  return undefined;
}

export function removeSession(
  projectPath: string,
  browser: string,
  pid?: number,
): void {
  const key = sessionKey(projectPath, browser);
  if (pid !== undefined && sessions.get(key)?.pid !== pid) return;
  sessions.delete(key);
  registrationStamps.delete(key);
}

export function listSessions(): ProcessInfo[] {
  return Array.from(sessions.values());
}
