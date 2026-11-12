// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { listSessions, readSessionMarkers } from "./process-manager";
import { pidState } from "./process-identity";

import type { ProcessInfo } from "./types";

export interface SessionGroup {
  projectPath: string;
  sessions: Array<{ browser: string; pid: number; mode: ProcessInfo["command"] }>;
}

export function groupByProject(sessions: Iterable<ProcessInfo>): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const s of sessions) {
    const key = path.resolve(s.projectPath);
    const group = groups.get(key) ?? { projectPath: s.projectPath, sessions: [] };
    group.sessions.push({ browser: s.browser, pid: s.pid, mode: s.command });
    groups.set(key, group);
  }

  return [...groups.values()];
}

export function describeGroups(groups: SessionGroup[]): string {
  return groups
    .map((g) => `${g.projectPath}: ${g.sessions.map((s) => `${s.browser} pid ${s.pid} (${s.mode})`).join(", ")}`)
    .join("; ");
}

export type OnlyLiveSession =
  | { kind: "none"; unreadable: string | null }
  | { kind: "one"; projectPath: string; unreadable: string | null }
  | { kind: "many"; sessions: SessionGroup[]; unreadable: string | null };

export function onlyLiveSession(): OnlyLiveSession {
  const candidates = new Map<string, ProcessInfo>();

  for (const s of listSessions()) {
    if (pidState(s.pid, s.processStartedAt) !== "alive") continue;

    candidates.set(`${path.resolve(s.projectPath)}::${s.browser}`, s);
  }

  const markersRead = readSessionMarkers();

  for (const m of markersRead.markers) {
    const foreign =
      typeof m.serverPid === "number" && m.serverPid !== process.pid && pidState(m.serverPid, m.serverStartedAt) === "alive";
    if (foreign || pidState(m.pid, m.processStartedAt) !== "alive") continue;

    const key = `${path.resolve(m.projectPath)}::${m.browser}`;
    if (!candidates.has(key)) candidates.set(key, m);
  }

  const groups = groupByProject(candidates.values());
  const unreadable = markersRead.unreadable;

  if (groups.length === 0) return { kind: "none", unreadable };
  if (groups.length === 1) return { kind: "one", projectPath: groups[0].projectPath, unreadable };

  return { kind: "many", sessions: groups, unreadable };
}
