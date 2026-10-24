// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { PROJECT_PATH } from "../lib/common-schema";
import {
  PLAUSIBLE_SESSION_BINARY,
  describeForeignPid,
  pidState,
  readWindowsProcessTable,
  type WindowsProcessRow,
  processCommand,
} from "../lib/process-identity";
import {
  findSessionInfo,
  readSessionMarkers,
  listSessions,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import {
  ambiguousSessionRefusal,
  resolveSessionBrowser,
} from "../lib/session-browser";
import { browserProfileRootDir, readyContractPath } from "../lib/session-paths";
import { removeCarrier } from "../lib/carrier";
import { contractBrowserPid, describeEnded, endedProcesses } from "../lib/stop-ended";
import { sweepCarriers, type CarrierSweepEntry } from "../lib/carrier-exit";
import { readRememberedCarriers } from "../lib/carrier-registry";
import { envelope } from "../lib/envelope";
import { killWindowsTree } from "../lib/exec";
import { trackUrl } from "../lib/track-url";

import type { ProcessInfo, ReadyContract } from "../lib/types";

export const schema = {
  name: "extension_stop",
  description:
    "Stop a session that extension_dev or extension_start is running: terminate the server and the browser it launched, and remove the live-preview carrier if extension_dev placed one. The answer names the server pid and the browser pid the launcher recorded, each with whether it is gone (serverGone, browserGone), so a \"close its browser\" ask is settled by this answer with no process check by hand. This covers extension_start build:false too, which the registry records as a preview session. Call it when you are done verifying, so sessions do not accumulate.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: {
        type: "string",
        description:
          "Browser of the session to stop. Only that browser's server and browser processes are ended; a session the same project runs for another browser keeps running. Defaults to the single live session for this project rather than assuming chrome; when the project runs sessions for more than one browser, the call is refused with the list instead of stopping one.",
      },
      all: {
        type: "boolean",
        default: false,
        description:
          "Stop every known session across projects and browsers, found from this server's registry AND the on-disk markers written by this server or by servers that are no longer running, so it still works after an MCP restart. Because it crosses projects, a call with no projectPath whose sessions span more than one project answers confirm-required with every session it would end grouped by project (wouldStop) and stops nothing until called again with confirm: true; projectPath beside it scopes the stop to that one project's sessions and carrier with no confirmation, and sessions that all belong to one project need none either. browser is ignored. A marker owned by another MCP server that is still running is left alone and listed under skippedForeign (foreign on a confirm-required answer) unless includeOtherServers is true. It also takes back every live-preview carrier still recorded on this machine, including one in a project whose session was never stopped.",
      },
      confirm: {
        type: "boolean",
        default: false,
        description:
          "With all: true and no projectPath, end every session the confirm-required answer listed, across projects. Without it, a stop that would cross projects only lists what it would end.",
      },
      includeOtherServers: {
        type: "boolean",
        default: false,
        description:
          "With all: true, also stop sessions whose markers belong to another MCP server that is still running (the markers sit in a per-user directory every server shares). Off by default, since those sessions are someone else's.",
      },
    },
    required: [],
  },
};

interface StopOutcome {
  projectPath: string;
  browser: string;
  pid: number | null;
  serverGone: boolean | null;
  browserPid: number | null;
  browserGone: boolean | null;
  stopped: boolean;
  reaped: number[];
  reapUnconfirmed?: number[];
  detail: string;
  carrierRemoved?: string;
  carrierNote?: string;
  staleRecord?: boolean;
  survivorsUnverified?: boolean;
}

function cleanCarrier(projectPath: string): { carrierRemoved?: string; carrierNote?: string } {
  const removal = removeCarrier(projectPath);
  if (removal.removed) return { carrierRemoved: removal.path };

  return removal.note && /Could not remove/i.test(removal.note)
    ? { carrierNote: `${removal.note} The carrier is still at ${removal.path}; the engine loads ./extensions, so remove it by hand before the next run.` }
    : {};
}

function pgrepPids(
  pattern: string,
  windowsTable?: () => WindowsProcessRow[] | null,
): number[] | null {
  if (process.platform === "win32") {
    const table = windowsTable ? windowsTable() : readWindowsProcessTable();
    if (!table) return null;

    const matcher = new RegExp(pattern, "i");

    return table
      .filter((row) => row.pid !== process.pid && matcher.test(row.commandLine))
      .map((row) => row.pid);
  }

  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });

    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch (err) {
    const status = (err as { status?: unknown })?.status;

    return status === 1 ? [] : null;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectPathForms(projectPath: string): string[] {
  const forms = new Set([projectPath, path.resolve(projectPath)]);

  try {
    forms.add(fs.realpathSync(projectPath));
  } catch {
  }

  return [...forms];
}

export interface ContractProcessHints {
  profilePath?: string;
  pids: number[];
}

export function contractProcessHints(
  projectPath: string,
  browser: string,
): ContractProcessHints {
  try {
    const contract: ReadyContract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    );
    const pids = [contract.browserPid, contract.launcherPid].filter(
      (pid): pid is number =>
        typeof pid === "number" && Number.isInteger(pid) && pid > 0,
    );

    return {
      ...(typeof contract.profilePath === "string" && contract.profilePath.trim()
        ? { profilePath: contract.profilePath }
        : {}),
      pids,
    };
  } catch {
    return { pids: [] };
  }
}

function commandLineOf(
  pid: number,
  windowsTable: () => WindowsProcessRow[] | null,
): string | null {
  if (process.platform === "win32") {
    return windowsTable()?.find((row) => row.pid === pid)?.commandLine ?? null;
  }

  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const ENGINE_DEFAULT_BROWSER = "chrome";

function namesAnotherBrowser(commandLine: string | null, browser: string): boolean {
  if (commandLine === null) return false;

  const named = commandLine.match(/--browser[= ]([^\s"']+)/);

  return (named ? named[1] : ENGINE_DEFAULT_BROWSER) !== browser;
}

function sessionProcessPids(
  projectPath: string,
  browser: string,
  hints: ContractProcessHints = { pids: [] },
): { pids: number[]; verified: boolean } {
  const pids = new Set<number>();
  let verified = true;
  let table: WindowsProcessRow[] | null | undefined;

  const windowsTable = (): WindowsProcessRow[] | null => {
    if (table === undefined) table = readWindowsProcessTable();

    return table;
  };

  const found = (pattern: string): number[] => {
    const hits = pgrepPids(pattern, windowsTable);

    if (hits === null) {
      verified = false;

      return [];
    }

    return hits;
  };

  if (hints.profilePath) {
    for (const pid of found(escapeRegex(hints.profilePath))) pids.add(pid);
  }

  for (const pid of hints.pids) {
    if (pid !== process.pid && isAlive(pid)) pids.add(pid);
  }

  for (const form of projectPathForms(projectPath)) {
    const escaped = escapeRegex(form);
    const cliCommandLine = `extension[^ ]* (dev|start|preview) ${escaped}`;
    const browserArgvNamingTheManagedProfile = `${escapeRegex(browserProfileRootDir(form, browser))}${escapeRegex(path.sep)}`;

    for (const pid of found(cliCommandLine)) {
      if (!namesAnotherBrowser(commandLineOf(pid, windowsTable), browser)) pids.add(pid);
    }

    for (const pid of found(browserArgvNamingTheManagedProfile)) pids.add(pid);
  }

  return {
    pids: [...pids].filter((pid) =>
      PLAUSIBLE_SESSION_BINARY.test(processCommand(pid)),
    ),
    verified,
  };
}

async function reapSessionProcesses(
  projectPath: string,
  browser: string,
  hints: ContractProcessHints = { pids: [] },
): Promise<{ reaped: number[]; unconfirmed: number[] }> {
  const { pids } = sessionProcessPids(projectPath, browser, hints);
  if (pids.length === 0) return { reaped: [], unconfirmed: [] };

  for (const pid of pids) {
    if (process.platform === "win32") {
      killWindowsTree(pid);
      continue;
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }

  await sleep(250);
  const reaped: number[] = [];
  const unconfirmed: number[] = [];

  for (const pid of pids) {
    (pidState(pid) === "dead" ? reaped : unconfirmed).push(pid);
  }

  return { reaped, unconfirmed };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  if (process.platform === "win32") return killWindowsTree(pid);

  try {
    process.kill(-pid, sig);

    return true;
  } catch {
    try {
      process.kill(pid, sig);

      return true;
    } catch {
      return false;
    }
  }
}

function pidFromReadyContract(
  projectPath: string,
  browser: string,
): number | null {
  try {
    const raw = fs.readFileSync(readyContractPath(projectPath, browser), "utf8");
    const contract: ReadyContract = JSON.parse(raw);

    return typeof contract.pid === "number" ? contract.pid : null;
  } catch {
    return null;
  }
}

export async function stopOne(
  projectPath: string,
  browser: string,
): Promise<StopOutcome> {
  const session = findSessionInfo(projectPath, browser);
  const pid = session?.pid ?? pidFromReadyContract(projectPath, browser);
  const hints = contractProcessHints(projectPath, browser);
  const browserPid = contractBrowserPid(projectPath, browser);
  const noBrowser = session?.noBrowser === true;

  if (pid == null) {
    const { reaped, unconfirmed } = await reapSessionProcesses(projectPath, browser, hints);
    removeSessionMarker(projectPath, browser);
    const ended = endedProcesses(null, browserPid);
    let detail: string;

    if (unconfirmed.length) {
      detail = `No dev pid on record. Killed orphaned browser process(es) from the profile dir, but ${unconfirmed.length} still report alive 250 ms later (pids ${unconfirmed.join(", ")})${reaped.length ? `; ${reaped.length} confirmed gone` : ""}.`;
    } else if (reaped.length) {
      detail = `No dev pid on record, but reaped ${reaped.length} orphaned browser process(es) from the profile dir, each confirmed gone.`;
    } else {
      detail = "No known session for this project/browser (nothing registered in this server and no ready.json contract found).";
    }

    return {
      projectPath,
      browser,
      pid: null,
      ...ended,
      stopped: reaped.length > 0 && unconfirmed.length === 0 && ended.browserGone !== false,
      reaped,
      ...(unconfirmed.length ? { reapUnconfirmed: unconfirmed } : {}),
      ...cleanCarrier(projectPath),
      detail: `${detail} ${describeEnded(ended, null, noBrowser)}`,
    };
  }

  let detail: string;
  const state = pidState(pid);

  if (state === "foreign") {
    removeSession(projectPath, browser);
    removeSessionMarker(projectPath, browser);

    try {
      fs.rmSync(readyContractPath(projectPath, browser), { force: true });
    } catch {
    }

    const ended = endedProcesses(null, browserPid);

    return {
      projectPath,
      browser,
      pid,
      ...ended,
      stopped: false,
      reaped: [],
      staleRecord: true,
      ...cleanCarrier(projectPath),
      detail: `Nothing was signalled: ${describeForeignPid(pid)}. The session that recorded it is already gone; its stale records were removed. ${describeEnded(ended, null, noBrowser)}`,
    };
  }

  if (state === "dead") {
    detail = "Process was already gone; cleaned up session records.";
  } else {
    signal(pid, "SIGTERM");
    await sleep(1500);

    if (isAlive(pid)) {
      signal(pid, "SIGKILL");
      await sleep(250);
    }

    detail = isAlive(pid)
      ? "Sent SIGTERM and SIGKILL but the process still reports alive; it may be exiting."
      : "Terminated.";
  }

  const { reaped } = await reapSessionProcesses(projectPath, browser, hints);

  const { pids: survivors, verified } = sessionProcessPids(projectPath, browser, hints);
  const dead = pidState(pid) === "dead";
  const ended = endedProcesses(dead, browserPid);
  const stopped = dead && verified && survivors.length === 0 && ended.browserGone !== false;

  if (!verified) {
    detail += " Warning: the search for surviving browser processes could not run (pgrep is missing or failed), so survivors were NOT verified; the browser may still be up.";
  } else if (survivors.length) {
    detail += ` Warning: ${survivors.length} browser process(es) still alive after reap (pids ${survivors.join(", ")}).`;
  } else if (reaped.length) {
    detail += ` Reaped ${reaped.length} browser process(es).`;
  }

  detail += ` ${describeEnded(ended, pid, noBrowser)}`;

  if (dead) {
    removeSession(projectPath, browser);
    removeSessionMarker(projectPath, browser);

    try {
      fs.rmSync(readyContractPath(projectPath, browser), { force: true });
    } catch {
    }
  }

  return {
    projectPath,
    browser,
    pid,
    ...ended,
    stopped,
    reaped,
    detail,
    ...(verified ? {} : { survivorsUnverified: true }),
    ...cleanCarrier(projectPath),
  };
}

interface SessionGroup {
  projectPath: string;
  sessions: Array<{ browser: string; pid: number; mode: ProcessInfo["command"] }>;
}

function groupByProject(sessions: Iterable<ProcessInfo>): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const s of sessions) {
    const key = path.resolve(s.projectPath);
    const group = groups.get(key) ?? { projectPath: s.projectPath, sessions: [] };
    group.sessions.push({ browser: s.browser, pid: s.pid, mode: s.command });
    groups.set(key, group);
  }

  return [...groups.values()];
}

function describeGroups(groups: SessionGroup[]): string {
  return groups
    .map((g) => `${g.projectPath}: ${g.sessions.map((s) => `${s.browser} pid ${s.pid} (${s.mode})`).join(", ")}`)
    .join("; ");
}

export async function handler(args: {
  projectPath?: string;
  browser?: string;
  all?: boolean;
  confirm?: boolean;
  includeOtherServers?: boolean;
}): Promise<string> {
  const consolePage = trackUrl("console", {});

  if (args.all) {
    const scope = args.projectPath ? path.resolve(args.projectPath) : null;
    const inScope = (projectPath: string): boolean => scope === null || path.resolve(projectPath) === scope;
    const candidates = new Map<string, ProcessInfo>();

    for (const s of listSessions()) {
      if (inScope(s.projectPath)) candidates.set(`${path.resolve(s.projectPath)}::${s.browser}`, s);
    }

    const markersRead = readSessionMarkers();
    const skippedForeign: Array<{ projectPath: string; browser: string; serverPid: number }> = [];

    for (const m of markersRead.markers) {
      if (!inScope(m.projectPath)) continue;

      const key = `${path.resolve(m.projectPath)}::${m.browser}`;
      const foreign =
        typeof m.serverPid === "number" && m.serverPid !== process.pid && pidState(m.serverPid) === "alive";

      if (foreign && !args.includeOtherServers) {
        skippedForeign.push({ projectPath: m.projectPath, browser: m.browser, serverPid: m.serverPid as number });
        continue;
      }

      if (!candidates.has(key)) candidates.set(key, m);
    }

    const wouldStop = groupByProject(candidates.values());

    if (scope === null && !args.confirm && wouldStop.length > 1) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "confirm-required",
        value: {
          wouldStop,
          foreign: skippedForeign,
          sayToPerson: `This would stop ${candidates.size} sessions across ${wouldStop.length} projects: ${describeGroups(wouldStop)}. Say stop again with confirm: true to end them all, or name projectPath to stop one project.`,
          trackUrl: consolePage,
        },
        warnings: [
          markersRead.unreadable ? `Session markers could not be fully read: ${markersRead.unreadable}; a session recorded there may still be running.` : null,
        ],
        hint: "Nothing was stopped. Call again with confirm: true to end every session listed, or pass projectPath beside all: true to stop one project's sessions with no confirmation.",
      });
    }

    const outcomes: StopOutcome[] = [];

    for (const c of candidates.values()) {
      outcomes.push(await stopOne(c.projectPath, c.browser));
    }

    const visited = new Set(
      outcomes.map((outcome) => path.resolve(outcome.projectPath)),
    );
    const carriersRead = readRememberedCarriers();
    const carriers: CarrierSweepEntry[] = sweepCarriers(
      carriersRead.carriers.filter((p) => inScope(p) && !visited.has(path.resolve(p))),
    );
    const unreadNotes = [
      skippedForeign.length
        ? `${skippedForeign.length} session(s) belong to other MCP servers that are still running (${skippedForeign.map((s) => `${s.browser} on ${s.projectPath}, server pid ${s.serverPid}`).join("; ")}) and were left alone; pass includeOtherServers: true to stop them too.`
        : null,
      markersRead.unreadable ? `Session markers could not be fully read: ${markersRead.unreadable}; a session recorded there may still be running.` : null,
      carriersRead.unreadable ? `Carrier records could not be fully read: ${carriersRead.unreadable}; a carrier recorded there may still be in place.` : null,
    ].filter((note): note is string => note !== null);

    if (candidates.size === 0 && carriers.length === 0) {
      return envelope({
        ok: unreadNotes.length === 0,
        command: schema.name,
        status: unreadNotes.length ? "nothing-found-unreadable" : "nothing-to-stop",
        value: { stopped: [], ...(skippedForeign.length ? { skippedForeign } : {}), trackUrl: consolePage },
        warnings: unreadNotes,
        hint: unreadNotes.length
          ? "No sessions registered in this server and nothing readable on disk, but part of the record could not be read, so nothing is known to be stopped."
          : "No sessions registered in this server, no session markers on disk, and no carrier left in any project this machine recorded. Nothing to stop.",
      });
    }

    return envelope({
      ok: outcomes.every((o) => o.stopped),
      command: schema.name,
      status: "stopped-all",
      value: {
        ...(skippedForeign.length ? { skippedForeign } : {}),
        stopped: outcomes,
        ...(carriers.length ? { carriersSwept: carriers } : {}),
        trackUrl: consolePage,
      },
      warnings: [
        ...outcomes.map((o) => (o.stopped ? null : o.detail)),
        ...carriers.map((c) =>
          c.removed
            ? `Took the live-preview carrier back out of ${c.projectPath}, which had no session left to stop it.`
            : `Left the carrier in ${c.projectPath} alone: ${c.note ?? "unknown reason"}`,
        ),
      ],
    });
  }

  if (!args.projectPath) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        message:
          "projectPath is required unless all=true. Pass the same projectPath used with extension_dev/extension_start.",
      },
      value: { trackUrl: consolePage },
    });
  }

  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const outcome = await stopOne(args.projectPath, browser);

  return envelope({
    ok: outcome.stopped,
    command: schema.name,
    status:
      outcome.pid === null
        ? "not-found"
        : outcome.stopped
          ? "stopped"
          : "still-alive",
    value: { ...outcome, trackUrl: consolePage },
    warnings: [outcome.stopped ? null : outcome.detail],
  });
}
