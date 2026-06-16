import type { ProcessInfo } from "./types";

// In-memory registry of running extension dev/start processes
// Lets the MCP server track sessions for source inspection and wait
const sessions = new Map<string, ProcessInfo>();

function sessionKey(projectPath: string, browser: string): string {
  return `${projectPath}::${browser}`;
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
