// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProcessInfo } from "./types";

const sessions = new Map<string, ProcessInfo>();

function sessionKey(projectPath: string, browser: string): string {
  return `${path.resolve(projectPath)}::${browser}`;
}

// On-disk session markers, one per projectPath+browser. The in-memory map dies
// with this process and loses its entry the moment a dev child exits, but the
// browser leg routinely outlives both: that gap is how extension_stop all:true
// answered "No sessions registered" while a session pid was demonstrably alive
// (surprise-swarm C5). Markers persist until an explicit stop prunes them, so
// all:true can rediscover the projects and then verify liveness through the
// same ready.json contract the projectPath path uses.
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

// Memory only, deliberately: this fires on child exit, and the child dying
// says nothing about the browser it launched (Firefox detaches). The marker
// stays until extension_stop prunes it, or all:true would forget a session
// whose browser is still holding the profile.
export function removeSession(projectPath: string, browser: string): void {
  sessions.delete(sessionKey(projectPath, browser));
}

export function listSessions(): ProcessInfo[] {
  return Array.from(sessions.values());
}
