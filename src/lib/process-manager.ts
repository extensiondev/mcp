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

import { localState } from "./local-state";
import { processStart, type ProcessStart } from "./process-identity";

import type { ProcessInfo } from "./types";

function sessionKey(projectPath: string, browser: string): string {
  return `${path.resolve(projectPath)}::${browser}`;
}

export function sessionStateDir(): string {
  return (
    process.env.EXTENSION_MCP_SESSION_DIR ||
    path.join(os.tmpdir(), "extension-dev-mcp-sessions")
  );
}

export function directoryNotCreatedYet(dir: string): boolean {
  const target = path.resolve(dir);
  let probe = target;

  for (;;) {
    const stat = fs.statSync(probe, { throwIfNoEntry: false });
    if (stat) return probe !== target && stat.isDirectory();

    const parent = path.dirname(probe);
    if (parent === probe) return false;

    probe = parent;
  }
}

function markerDir(): string {
  return sessionStateDir();
}

const MARKER_FILE = /^[0-9a-f]{16}\.json$/;

function heldMarkerName(projectPath: string, browser: string, digest: string): string | null {
  const dir = markerDir();
  if (fs.existsSync(path.join(dir, `${digest}.json`))) return null;

  let files: string[];

  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const resolved = path.resolve(projectPath);

  for (const file of files) {
    if (!MARKER_FILE.test(file)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

      if (typeof parsed?.projectPath === "string" && path.resolve(parsed.projectPath) === resolved && parsed.browser === browser) return file.slice(0, 16);
    } catch {
    }
  }

  return null;
}

/* @invariant
 * A SESSION KEEPS THE FILE NAME ITS MARKER ALREADY HAS.
 *
 * The name is the first 16 hex characters of a SHA-256 of the session key.
 * Releases through 11.0.0 named it from a SHA-1, and a session outlives the
 * server that started it, so a marker found on disk for the same project
 * and browser under another name is the session's own: its name is reused
 * for the marker and every sidecar until the session ends. The marker is
 * matched by what it holds, never by recomputing the old digest.
 */
function markerDigest(projectPath: string, browser: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(sessionKey(projectPath, browser))
    .digest("hex")
    .slice(0, 16);

  return heldMarkerName(projectPath, browser, digest) ?? digest;
}

function markerPath(projectPath: string, browser: string): string {
  return path.join(markerDir(), `${markerDigest(projectPath, browser)}.json`);
}

export function sessionMarkerPath(projectPath: string, browser: string): string {
  return markerPath(projectPath, browser);
}

export function sessionSidecarPath(projectPath: string, browser: string, name: string): string {
  return path.join(markerDir(), `${markerDigest(projectPath, browser)}.${name}.json`);
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

  for (const target of [file, sessionSidecarPath(projectPath, browser, "idle")]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
    }
  }
}

export function readSessionMarkers(): { markers: ProcessInfo[]; unreadable: string | null } {
  let files: string[];

  try {
    files = fs.readdirSync(markerDir());
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const absent = code === "ENOENT" && directoryNotCreatedYet(markerDir());

    return {
      markers: [],
      unreadable: absent ? null : `${markerDir()}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const out: ProcessInfo[] = [];
  const torn: string[] = [];

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
      torn.push(file);
    }
  }

  return {
    markers: out,
    unreadable: torn.length ? `${torn.length} marker file${torn.length === 1 ? "" : "s"} under ${markerDir()} could not be parsed (${torn.slice(0, 3).join(", ")})` : null,
  };
}

export function listSessionMarkers(): ProcessInfo[] {
  return readSessionMarkers().markers;
}

let serverStartCache: ProcessStart | undefined;

function serverStart(): ProcessStart {
  serverStartCache ??= processStart(process.pid);

  return serverStartCache;
}

function writeMarkerBestEffort(info: ProcessInfo, registeredAtMs: number): string | null {
  const { startedAt, startTicks } = serverStart();

  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(
      markerPath(info.projectPath, info.browser),
      JSON.stringify({
        ...info,
        projectPath: path.resolve(info.projectPath),
        serverPid: process.pid,
        ...(startedAt ? { serverStartedAt: startedAt } : {}),
        ...(startTicks !== undefined ? { serverStartTicks: startTicks } : {}),
        registeredAt: new Date(registeredAtMs).toISOString(),
      }),
    );

    return null;
  } catch (error) {
    return `The session marker could not be written to ${markerDir()} (${error instanceof Error ? error.message : String(error)}), so if this server restarts, extension_stop (all: true) and the fork guard will not see this session; stop it by projectPath and browser, or by its pid ${info.pid}.`;
  }
}

export type ContractPidRecord = Partial<
  Pick<ProcessInfo, "browserPid" | "browserStartedAt" | "browserStartTicks" | "launcherPid" | "launcherStartedAt" | "launcherStartTicks">
>;

const CONTRACT_PID_FIELDS = ["browserPid", "browserStartedAt", "browserStartTicks", "launcherPid", "launcherStartedAt", "launcherStartTicks"] as const;

function contractPidsOf(info: ProcessInfo | undefined): ContractPidRecord {
  const out: ContractPidRecord = {};
  if (!info) return out;

  for (const field of CONTRACT_PID_FIELDS) {
    const value = info[field];
    if (value !== undefined) Object.assign(out, { [field]: value });
  }

  return out;
}

export function registerSession(info: ProcessInfo): string | null {
  const key = sessionKey(info.projectPath, info.browser);
  const { sessions, registrations } = localState();
  const prior = registrations.get(key);
  const samePid = prior !== undefined && prior.pid === info.pid;
  const at = samePid ? prior.at : Date.now();
  const known = info.processStartedAt ?? (samePid ? prior.startedAt : undefined);
  const read = known === undefined ? processStart(info.pid) : undefined;
  const startedAt = known ?? read?.startedAt ?? undefined;
  const startTicks = info.processStartTicks ?? (samePid && known === prior.startedAt ? prior.startTicks : undefined) ?? read?.startTicks;
  const carried = samePid ? contractPidsOf(sessions.get(key)) : {};
  const recorded: ProcessInfo = {
    ...carried,
    ...info,
    ...(startedAt ? { processStartedAt: startedAt } : {}),
    ...(startTicks !== undefined ? { processStartTicks: startTicks } : {}),
  };
  registrations.set(key, { pid: info.pid, at, ...(startedAt ? { startedAt } : {}), ...(startTicks !== undefined ? { startTicks } : {}) });
  sessions.set(key, recorded);

  return writeMarkerBestEffort(recorded, at);
}

export function recordContractPids(projectPath: string, browser: string, record: ContractPidRecord): void {
  const key = sessionKey(projectPath, browser);
  const { sessions } = localState();
  const inMemory = sessions.get(key);
  if (inMemory) sessions.set(key, { ...inMemory, ...record });

  const file = markerPath(projectPath, browser);

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    if (inMemory && typeof parsed.pid === "number" && parsed.pid !== inMemory.pid) return;

    fs.writeFileSync(file, JSON.stringify({ ...parsed, ...record }));
  } catch {
  }
}

export function sessionSinceMs(
  projectPath: string,
  browser: string,
): number | null {
  const stamp = localState().registrations.get(sessionKey(projectPath, browser));
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

export function findSessionInfo(
  projectPath: string,
  browser: string,
): ProcessInfo | undefined {
  const inMemory = localState().sessions.get(sessionKey(projectPath, browser));
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
  const { sessions, registrations } = localState();
  if (pid !== undefined && sessions.get(key)?.pid !== pid) return;

  sessions.delete(key);
  registrations.delete(key);
}

export function listSessions(): ProcessInfo[] {
  return Array.from(localState().sessions.values());
}
