// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listSessionMarkers, listSessions, sessionMarkerPath, sessionSidecarPath, sessionStateDir } from "./process-manager";
import { readyContractPath } from "./session-paths";
import { annotate } from "./tool-frames";

export const DEFAULT_IDLE_MINUTES = 30;
const WATCHDOG_FILE = path.join("bin", "session-watchdog.mjs");
const IDLE_SIDECAR = "idle";
const IDLED_OUT_SIDECAR = "idled-out";

export const IDLE_MINUTES_SCHEMA = {
  idleMinutes: {
    type: "number",
    description: "Idle minutes before it ends itself; 0 never; default 30 headless.",
  },
} as const;

export const idleClock = {
  pollMs: 20_000,
  graceMs: 1_500,
};

export interface IdleRecord {
  pid: number;
  session: { projectPath: string; browser: string };
  idleMinutes: number;
  idleMs: number;
  pollMs: number;
  graceMs: number;
  armedAt: string;
  contractPath: string;
  markerPath: string;
  idledOutPath: string;
}

export interface IdledOut {
  pid: number | null;
  session: { projectPath: string; browser: string };
  idleMinutes: number | null;
  lastCallAt: string | null;
  idledOutAt: string | null;
  processes: Array<{ pid: number; gone: boolean }>;
}

export function resolveIdleMinutes(asked: number | undefined, ownedByAgent: boolean): number | null {
  if (typeof asked === "number" && Number.isFinite(asked)) return asked > 0 ? asked : null;

  return ownedByAgent ? DEFAULT_IDLE_MINUTES : null;
}

export function idleRecordPath(projectPath: string, browser: string): string {
  return sessionSidecarPath(projectPath, browser, IDLE_SIDECAR);
}

export function idledOutPath(projectPath: string, browser: string): string {
  return sessionSidecarPath(projectPath, browser, IDLED_OUT_SIDECAR);
}

export function watchdogPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = path.join(dir, WATCHDOG_FILE);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) return candidate;

    dir = parent;
  }
}

function startWatchdog(recordPath: string): number | null {
  try {
    const child = spawn(process.execPath, [watchdogPath(), recordPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.unref();

    return child.pid ?? null;
  } catch {
    return null;
  }
}

export function armSessionIdle(facts: {
  projectPath: string;
  browser: string;
  pid: number;
  idleMinutes: number | null;
}): string | null {
  const { projectPath, browser, pid, idleMinutes } = facts;
  const recordPath = idleRecordPath(projectPath, browser);

  try {
    fs.rmSync(idledOutPath(projectPath, browser), { force: true });
  } catch {
  }

  if (idleMinutes === null) {
    try {
      fs.rmSync(recordPath, { force: true });
    } catch {
    }

    return null;
  }

  const record: IdleRecord = {
    pid,
    session: { projectPath: path.resolve(projectPath), browser },
    idleMinutes,
    idleMs: Math.round(idleMinutes * 60_000),
    pollMs: Math.min(idleClock.pollMs, Math.max(50, Math.round((idleMinutes * 60_000) / 4))),
    graceMs: idleClock.graceMs,
    armedAt: new Date().toISOString(),
    contractPath: readyContractPath(projectPath, browser),
    markerPath: sessionMarkerPath(projectPath, browser),
    idledOutPath: idledOutPath(projectPath, browser),
  };

  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(record));
  } catch (error) {
    return `The idle record could not be written to ${recordPath} (${error instanceof Error ? error.message : String(error)}), so this session will not end itself after ${idleMinutes} minutes idle; call extension_stop when you are done.`;
  }

  if (startWatchdog(recordPath) === null) {
    return `The idle watchdog could not be started, so this session will not end itself after ${idleMinutes} minutes idle; call extension_stop when you are done.`;
  }

  return null;
}

export function idleSentence(idleMinutes: number | null): string {
  return idleMinutes === null
    ? "This session has no idle limit and runs until extension_stop; pass idleMinutes to have it end itself after that many minutes without a tool call."
    : `This session ends itself after ${idleMinutes} minutes without a tool call naming its projectPath (every such call resets the clock); pass idleMinutes to change that, 0 for no limit.`;
}

function sessionsOf(projectPath: string): Array<{ projectPath: string; browser: string }> {
  const resolved = path.resolve(projectPath);
  const seen = new Map<string, { projectPath: string; browser: string }>();

  for (const session of [...listSessions(), ...listSessionMarkers()]) {
    if (path.resolve(session.projectPath) !== resolved) continue;

    seen.set(session.browser, { projectPath: resolved, browser: session.browser });
  }

  return [...seen.values()];
}

export function touchSessionIdle(projectPath: string, browser?: string): string[] {
  const targets = browser ? [{ projectPath, browser }] : sessionsOf(projectPath);
  const touched: string[] = [];
  const now = new Date();

  for (const target of targets) {
    const file = idleRecordPath(target.projectPath, target.browser);

    try {
      fs.utimesSync(file, now, now);
      touched.push(target.browser);
    } catch {
    }
  }

  return touched;
}

export function readIdledOut(projectPath: string, browser: string): IdledOut | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(idledOutPath(projectPath, browser), "utf8")) as Partial<IdledOut>;
    const session = parsed.session && typeof parsed.session === "object" ? parsed.session : { projectPath: path.resolve(projectPath), browser };

    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      session: { projectPath: String(session.projectPath ?? path.resolve(projectPath)), browser: String(session.browser ?? browser) },
      idleMinutes: typeof parsed.idleMinutes === "number" ? parsed.idleMinutes : null,
      lastCallAt: typeof parsed.lastCallAt === "string" ? parsed.lastCallAt : null,
      idledOutAt: typeof parsed.idledOutAt === "string" ? parsed.idledOutAt : null,
      processes: Array.isArray(parsed.processes) ? parsed.processes : [],
    };
  } catch {
    return null;
  }
}

export function clearIdledOut(projectPath: string, browser: string): void {
  try {
    fs.rmSync(idledOutPath(projectPath, browser), { force: true });
  } catch {
  }
}

export function idledOutSentence(ended: IdledOut): string {
  const left = ended.processes.filter((entry) => !entry.gone).map((entry) => entry.pid);
  const survivors = left.length ? ` Process${left.length === 1 ? "" : "es"} ${left.join(", ")} still reported alive when it ended; extension_stop reaps them.` : "";

  return `The ${ended.session.browser} session for ${ended.session.projectPath}${ended.pid === null ? "" : ` (pid ${ended.pid})`} ended itself at ${ended.idledOutAt ?? "an unrecorded time"}: no tool call named it for ${ended.idleMinutes ?? "its"} minutes (the last one was at ${ended.lastCallAt ?? "an unrecorded time"}). Start it again with extension_dev or extension_start; pass idleMinutes: 0 for no limit.${survivors}`;
}

function failed(answer: string): boolean {
  try {
    const parsed = JSON.parse(answer) as { ok?: unknown };

    return parsed.ok === false;
  } catch {
    return false;
  }
}

function endedSessionsOf(projectPath: string, browser: string | undefined): IdledOut[] {
  if (browser) {
    const ended = readIdledOut(projectPath, browser);

    return ended ? [ended] : [];
  }

  const resolved = path.resolve(projectPath);
  let files: string[];

  try {
    files = fs.readdirSync(sessionStateDir());
  } catch {
    return [];
  }

  const out: IdledOut[] = [];

  for (const file of files) {
    if (!file.endsWith(`.${IDLED_OUT_SIDECAR}.json`)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sessionStateDir(), file), "utf8")) as Partial<IdledOut>;
      const session = parsed.session;

      if (session && typeof session.projectPath === "string" && typeof session.browser === "string" && path.resolve(session.projectPath) === resolved) {
        const ended = readIdledOut(session.projectPath, session.browser);
        if (ended) out.push(ended);
      }
    } catch {
    }
  }

  return out;
}

export async function withSessionIdle(
  args: Record<string, unknown>,
  call: () => Promise<string>,
): Promise<string> {
  const projectPath = typeof args.projectPath === "string" && args.projectPath.trim() ? args.projectPath : null;
  if (!projectPath) return call();

  const browser = typeof args.browser === "string" && args.browser.trim() ? args.browser : undefined;
  touchSessionIdle(projectPath, browser);

  const answer = await call();
  if (!failed(answer)) return answer;

  const ended = endedSessionsOf(projectPath, browser);
  if (!ended.length) return answer;

  for (const entry of ended) clearIdledOut(entry.session.projectPath, entry.session.browser);

  return annotate(answer, { warning: ended.map(idledOutSentence).join(" ") });
}
