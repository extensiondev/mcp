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
): void {
  try {
    fs.rmSync(markerPath(projectPath, browser), { force: true });
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

export function registerSession(info: ProcessInfo): void {
  sessions.set(sessionKey(info.projectPath, info.browser), info);
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(
      markerPath(info.projectPath, info.browser),
      JSON.stringify({
        ...info,
        projectPath: path.resolve(info.projectPath),
        registeredAt: new Date().toISOString(),
      }),
    );
  } catch {
    // A marker is a best-effort breadcrumb; failing to write one must not
    // block the session itself.
  }
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

export function removeSession(projectPath: string, browser: string): void {
  sessions.delete(sessionKey(projectPath, browser));
}

export function listSessions(): ProcessInfo[] {
  return Array.from(sessions.values());
}
