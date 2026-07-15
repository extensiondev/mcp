import path from "node:path";
import type { ProcessInfo } from "./types";

// In-memory registry of running extension dev/start/preview processes.
// Lets the MCP server track sessions so extension_stop can terminate them
// and so lifecycle tools can report what is running.
const sessions = new Map<string, ProcessInfo>();

// Keys are normalized so the path the caller passes to extension_stop matches
// the path extension_dev registered, even if one is relative or has a
// trailing slash.
function sessionKey(projectPath: string, browser: string): string {
  return `${path.resolve(projectPath)}::${browser}`;
}

export function registerSession(info: ProcessInfo): void {
  sessions.set(sessionKey(info.projectPath, info.browser), info);
}

export function getSession(
  projectPath: string,
  browser: string,
): ProcessInfo | undefined {
  return sessions.get(sessionKey(projectPath, browser));
}

export function removeSession(projectPath: string, browser: string): void {
  sessions.delete(sessionKey(projectPath, browser));
}

export function listSessions(): ProcessInfo[] {
  return Array.from(sessions.values());
}
