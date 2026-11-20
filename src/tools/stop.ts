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
  describeForeignPid,
  describeRecycledPid,
  namedLikeSessionProcess,
  pidState,
  processStartTimes,
  processStartedAt,
  readWindowsProcessTable,
  startedAsRecorded,
  type PidState,
  type WindowsProcessRow,
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
import { contractPid, contractPidStartedAt } from "../lib/contract-pids";
import { contractBrowserPid, describeEnded, endedProcesses, readReadyContract } from "../lib/stop-ended";
import { sweepCarriers, type CarrierSweepEntry } from "../lib/carrier-exit";
import { readRememberedCarriers } from "../lib/carrier-registry";
import { envelope, okOrRefusal, type EnvelopeError } from "../lib/envelope";
import { dropNetworkStubs } from "../lib/network-stubs";
import { describeGroups, groupByProject, onlyLiveSession } from "../lib/only-live-session";
import { killWindowsTree } from "../lib/exec";
import { trackUrl } from "../lib/track-url";

import type { ProcessInfo, ReadyContract } from "../lib/types";

export const schema = {
  name: "extension_stop",
  description:
    "Stop a dev or start session and its browser when done; answers the server and browser pid it ended.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        ...PROJECT_PATH,
        description:
          "Project root; optional when exactly one project has a live session.",
      },
      browser: {
        type: "string",
        description:
          "Session browser; default the only live one.",
      },
      all: {
        type: "boolean",
        default: false,
        description:
          "Stop every session; across projects needs confirm.",
      },
      confirm: {
        type: "boolean",
        default: false,
        description:
          "With all: confirm the listed stop.",
      },
      includeOtherServers: {
        type: "boolean",
        default: false,
        description:
          "With all: include other servers' sessions.",
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
  pidIsStranger?: boolean;
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
    if (status === 1) return [];

    return process.platform === "linux" ? procCommandLinePids(pattern) : null;
  }
}

function procCommandLinePids(pattern: string): number[] | null {
  let entries: string[];

  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }

  const matcher = new RegExp(pattern);
  const pids: number[] = [];

  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;

    try {
      if (matcher.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "))) pids.push(pid);
    } catch {
    }
  }

  return pids;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATH_OPENS = "(^|[ =\"'])";
const PATH_CLOSES = "([\"' ]|$)";
const PATH_CLOSES_OR_DESCENDS = "([/\\\\\"' ]|$)";
const OPTIONAL_TRAILING_SEPARATOR = "[/\\\\]?";

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
  startedAt?: Record<number, string>;
}

export function contractProcessHints(
  projectPath: string,
  browser: string,
): ContractProcessHints {
  const contract = readReadyContract(projectPath, browser);
  if (!contract) return { pids: [] };

  const pids = [contract.browserPid, contract.launcherPid].filter(
    (pid): pid is number =>
      typeof pid === "number" && Number.isInteger(pid) && pid > 0,
  );
  const startedAt: Record<number, string> = {};

  for (const role of ["browser", "launcher"] as const) {
    const stamp = contractPidStartedAt(projectPath, browser, contract, role);
    const pid = role === "browser" ? contract.browserPid : contract.launcherPid;
    if (stamp && typeof pid === "number") startedAt[pid] = stamp;
  }

  return {
    ...(typeof contract.profilePath === "string" && contract.profilePath.trim()
      ? { profilePath: contract.profilePath }
      : {}),
    pids,
    ...(Object.keys(startedAt).length > 0 ? { startedAt } : {}),
  };
}

function commandLineOf(
  pid: number,
  windowsTable: () => WindowsProcessRow[] | null,
): string | null {
  if (process.platform === "win32") {
    return windowsTable()?.find((row) => row.pid === pid)?.commandLine ?? null;
  }

  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
  }

  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
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
    for (const pid of found(`${PATH_OPENS}${escapeRegex(hints.profilePath)}${PATH_CLOSES_OR_DESCENDS}`)) pids.add(pid);
  }

  for (const pid of hints.pids) {
    if (pid !== process.pid && pidState(pid, hints.startedAt?.[pid]) !== "dead") pids.add(pid);
  }

  for (const form of projectPathForms(projectPath)) {
    const escaped = escapeRegex(form);
    const cliCommandLine = `extension[^ ]* (dev|start|preview) ["']?${escaped}${OPTIONAL_TRAILING_SEPARATOR}${PATH_CLOSES}`;
    const browserArgvNamingTheManagedProfile = `${PATH_OPENS}${escapeRegex(browserProfileRootDir(form, browser))}${escapeRegex(path.sep)}`;

    for (const pid of found(cliCommandLine)) {
      if (!namesAnotherBrowser(commandLineOf(pid, windowsTable), browser)) pids.add(pid);
    }

    for (const pid of found(browserArgvNamingTheManagedProfile)) pids.add(pid);
  }

  return {
    pids: [...pids].filter(
      (pid) => startedAsRecorded(pid, hints.startedAt?.[pid]) || namedLikeSessionProcess(pid),
    ),
    verified,
  };
}

/* @invariant THE RECORDS OF A SESSION LEAVE ONLY WITH THE SESSION. A recorded
 * PID that reads as a stranger's is never signalled, but that reading is not
 * proof the session is gone: on 2026-11-18 (ledger 943) a session started
 * through npm exec read as foreign by its title, extension_stop removed its
 * records, answered E_NO_SESSION and left the dev server and the browser up
 * with nothing on record to stop them by. Two rules follow. A PID with no
 * start time to compare whose own command line names this project's session
 * (the engine's dev, start or preview on this folder for this browser, or
 * the managed profile) is the session's and is ended. And when the PID is a
 * stranger's, the session's browser processes are still ended, and the
 * records are removed only when the recorded browser is gone, no survivor
 * is found and the search for survivors could run; otherwise the records
 * stay and the answer is E_STOP_INCOMPLETE, saying they were kept.
 */
const ENGINE_VERB_BEFORE_A_PATH = /extension[^ ]* (?:dev|start|preview) ["']?$/;

function engineRunsOn(commandLine: string, folder: string): boolean {
  const insensitive = process.platform === "win32";
  const haystack = insensitive ? commandLine.toLowerCase() : commandLine;
  const needle = insensitive ? folder.toLowerCase() : folder;

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const after = haystack.charAt(at + needle.length);
    const closed = after === "" || after === '"' || after === "'" || after.trim() === "";

    if (closed && ENGINE_VERB_BEFORE_A_PATH.test(haystack.slice(Math.max(0, at - 96), at))) return true;
  }

  return false;
}

function commandLineNamesSession(
  pid: number,
  projectPath: string,
  browser: string,
  hints: ContractProcessHints,
): boolean {
  let table: WindowsProcessRow[] | null | undefined;
  const commandLine = commandLineOf(pid, () => {
    if (table === undefined) table = readWindowsProcessTable();

    return table;
  });
  if (!commandLine) return false;
  if (hints.profilePath && commandLine.includes(hints.profilePath)) return true;

  return projectPathForms(projectPath).some(
    (form) =>
      commandLine.includes(`${browserProfileRootDir(form, browser)}${path.sep}`) ||
      (engineRunsOn(commandLine, form) && !namesAnotherBrowser(commandLine, browser)),
  );
}

async function reapSessionProcesses(
  projectPath: string,
  browser: string,
  hints: ContractProcessHints = { pids: [] },
): Promise<{ reaped: number[]; unconfirmed: number[] }> {
  const { pids } = sessionProcessPids(projectPath, browser, hints);
  if (pids.length === 0) return { reaped: [], unconfirmed: [] };

  const startedAt = processStartTimes(pids);

  for (const [pid, stamp] of Object.entries(hints.startedAt ?? {})) startedAt.set(Number(pid), stamp);

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
    (pidState(pid, startedAt.get(pid)) === "dead" ? reaped : unconfirmed).push(pid);
  }

  return { reaped, unconfirmed };
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

const CONTRACT_WRITE_TOLERANCE_MS = 2_000;

function startedAfterContract(pid: number, projectPath: string, browser: string): string | null {
  let writtenMs: number;

  try {
    writtenMs = fs.statSync(readyContractPath(projectPath, browser)).mtimeMs;
  } catch {
    return null;
  }

  const current = processStartedAt(pid);
  if (current === null) return null;

  return Date.parse(current) - writtenMs > CONTRACT_WRITE_TOLERANCE_MS ? current : null;
}

/* @invariant A STOP THAT ENDED NOTHING IS A REFUSAL WITH A CODE AND A NEXT
 * STEP. It stays `ok: false` with the status it had ("not-found",
 * "still-alive"): value.stopped is false, the sibling call with no
 * projectPath already answers E_NO_SESSION for the same fact, and a caller
 * that named the wrong folder or browser has to learn the session it meant
 * is still up, which `ok: true` would hide. Before ledger 912 the answer
 * was `ok: false` with `error: null`. No session on record, or a record
 * whose process is already gone, is E_NO_SESSION; a process that was
 * signalled and still reports alive is E_STOP_INCOMPLETE. A PID this server
 * read as a stranger's is never offered for ending: its hint says to leave
 * it alone and names the one call that moves on. And a hint never says a
 * process still reports alive when the only open question is a survivor
 * search that could not run.
 */
function notStoppedRefusal(outcome: StopOutcome): EnvelopeError {
  if (outcome.staleRecord) {
    return {
      code: "E_NO_SESSION",
      message: outcome.detail,
      hint: "No session was left to stop and its stale records are gone. Start a new one with extension_dev.",
    };
  }

  if (outcome.pid === null && !outcome.reapUnconfirmed?.length) {
    return {
      code: "E_NO_SESSION",
      message: outcome.detail,
      hint: "Nothing was stopped. If the session runs from another folder or browser, pass that projectPath and browser; all: true sweeps every session recorded on this machine.",
    };
  }

  if (outcome.pidIsStranger) {
    const leaveAlone = `Pid ${outcome.pid} is not this session's process: leave it running, and never hand it to the person to end.`;

    return {
      code: "E_STOP_INCOMPLETE",
      message: outcome.detail,
      hint: outcome.survivorsUnverified && outcome.browserGone !== false
        ? `${leaveAlone} The session's records clear on a later extension_stop once that pid has exited or the search for surviving browser processes can run. Until then, call extension_dev with this projectPath and browser: it does not count these records as a live session and starts a fresh one over them.`
        : `${leaveAlone} The session's own browser is what is still up, and its records were kept so it can be stopped: call extension_stop with the same projectPath and browser again.`,
    };
  }

  if (outcome.survivorsUnverified && outcome.serverGone === true) {
    return {
      code: "E_STOP_INCOMPLETE",
      message: outcome.detail,
      hint: "The session's server is gone and its records were removed; no process is known to be alive. What is missing is the search for surviving browser processes, which could not run, so a browser window may still be open. Ask the person whether the session's browser window is still open and to close it if so.",
    };
  }

  return {
    code: "E_STOP_INCOMPLETE",
    message: outcome.detail,
    hint: "A process this answer names still reports alive. Call extension_stop with the same projectPath and browser again; if its pid survives, ask the person to end it.",
  };
}

export async function stopOne(
  projectPath: string,
  browser: string,
): Promise<StopOutcome> {
  dropNetworkStubs(projectPath, browser);
  const session = findSessionInfo(projectPath, browser);
  const contract = readReadyContract(projectPath, browser);
  const pid = session?.pid ?? pidFromReadyContract(projectPath, browser);
  const startedAt =
    session?.processStartedAt ??
    (pid !== null && contractPid(contract, "engine") === pid ? contractPidStartedAt(projectPath, browser, contract, "engine") : null);
  const reusedSince = pid !== null && !session && !startedAt ? startedAfterContract(pid, projectPath, browser) : null;
  const hints = contractProcessHints(projectPath, browser);
  const browserPid = contractBrowserPid(projectPath, browser);
  const browserStartedAt = contractPidStartedAt(projectPath, browser, contract, "browser");
  const noBrowser = session?.noBrowser === true;

  if (pid == null) {
    const { reaped, unconfirmed } = await reapSessionProcesses(projectPath, browser, hints);
    removeSessionMarker(projectPath, browser);
    const ended = endedProcesses(null, browserPid, browserStartedAt);
    let detail: string;

    if (unconfirmed.length) {
      detail = `No dev pid on record. Killed orphaned session process(es), found by a command line that names this project's engine or its managed profile, but ${unconfirmed.length} still report alive 250 ms later (pids ${unconfirmed.join(", ")})${reaped.length ? `; ${reaped.length} confirmed gone` : ""}.`;
    } else if (reaped.length) {
      detail = `No dev pid on record, but reaped ${reaped.length} orphaned session process(es), found by a command line that names this project's engine or its managed profile, each confirmed gone.`;
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

  const readState = (): PidState => {
    if (reusedSince !== null) return "dead";

    const read = pidState(pid, startedAt);

    return read === "foreign" && commandLineNamesSession(pid, projectPath, browser, hints) ? "alive" : read;
  };

  const state = readState();

  if (state === "foreign") {
    const stranger = describeForeignPid(pid);
    const { reaped } = await reapSessionProcesses(projectPath, browser, hints);
    const { pids: survivors, verified } = sessionProcessPids(projectPath, browser, hints);
    const ended = endedProcesses(null, browserPid, browserStartedAt);
    const provenGone = verified && survivors.length === 0 && ended.browserGone !== false;

    if (provenGone) {
      removeSession(projectPath, browser);
      removeSessionMarker(projectPath, browser);

      try {
        fs.rmSync(readyContractPath(projectPath, browser), { force: true });
      } catch {
      }
    }

    const kept = !verified
      ? "the search for surviving browser processes could not run (the process list could not be read), so survivors were NOT verified"
      : survivors.length
        ? `${survivors.length} browser process(es) still alive after reap (pids ${survivors.join(", ")})`
        : "the browser the launcher recorded is still alive";

    return {
      projectPath,
      browser,
      pid,
      ...ended,
      stopped: provenGone && reaped.length > 0,
      reaped,
      ...(provenGone && reaped.length === 0 ? { staleRecord: true } : {}),
      ...(verified ? {} : { survivorsUnverified: true }),
      ...(provenGone ? {} : { pidIsStranger: true }),
      ...(provenGone ? cleanCarrier(projectPath) : {}),
      detail: provenGone
        ? `Nothing was signalled: ${stranger}. The session that recorded it is already gone; its stale records were removed.${reaped.length ? ` Reaped ${reaped.length} browser process(es).` : ""} ${describeEnded(ended, null, noBrowser)}`
        : `Nothing was signalled: ${stranger}. The session's records were kept, because the session is not proven gone: ${kept}. Pid ${pid} is to be left running. ${describeEnded(ended, null, noBrowser)}`,
    };
  }

  if (state === "dead") {
    const recycled =
      reusedSince !== null
        ? `pid ${pid} now belongs to a process started at ${reusedSince}, after the ready contract that names it was last written`
        : describeRecycledPid(pid, startedAt);
    detail = recycled
      ? `Process was already gone: ${recycled}, so nothing was signalled; cleaned up session records.`
      : "Process was already gone; cleaned up session records.";
  } else {
    signal(pid, "SIGTERM");
    await sleep(1500);
    let after = readState();

    if (after === "alive") {
      signal(pid, "SIGKILL");
      await sleep(250);
      after = readState();
    }

    detail =
      after === "alive"
        ? "Sent SIGTERM and SIGKILL but the process still reports alive; it may be exiting."
        : after === "foreign"
          ? `Sent SIGTERM; ${describeForeignPid(pid)}, so it was not signalled again and is to be left running.`
          : "Terminated.";
  }

  const { reaped } = await reapSessionProcesses(projectPath, browser, hints);

  const { pids: survivors, verified } = sessionProcessPids(projectPath, browser, hints);
  const settled = readState();
  const dead = settled === "dead";
  const strangerNow = settled === "foreign";
  const ended = endedProcesses(strangerNow ? null : dead, browserPid, browserStartedAt);
  const stopped = dead && verified && survivors.length === 0 && ended.browserGone !== false;

  if (!verified) {
    detail += " Warning: the search for surviving browser processes could not run (the process list could not be read), so survivors were NOT verified; the browser may still be up.";
  } else if (survivors.length) {
    detail += ` Warning: ${survivors.length} browser process(es) still alive after reap (pids ${survivors.join(", ")}).`;
  } else if (reaped.length) {
    detail += ` Reaped ${reaped.length} browser process(es).`;
  }

  detail += ` ${describeEnded(ended, strangerNow ? null : pid, noBrowser)}`;

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
    ...(strangerNow ? { pidIsStranger: true } : {}),
    ...cleanCarrier(projectPath),
  };
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
        typeof m.serverPid === "number" && m.serverPid !== process.pid && pidState(m.serverPid, m.serverStartedAt) === "alive";

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
        error: {
          code: "E_BAD_REQUEST",
          message: `Nothing was stopped: all: true would end ${candidates.size} sessions across ${wouldStop.length} projects, which takes confirm: true.`,
        },
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
        ...okOrRefusal(unreadNotes.length === 0, () => ({
          code: "E_STOP_INCOMPLETE",
          message: "Nothing was found to stop, but part of the session record could not be read, so a session may still be running.",
          hint: "warnings names what could not be read. Fix that and call extension_stop with all: true again, or pass projectPath to stop one project's session from its own folder.",
        })),
        command: schema.name,
        status: unreadNotes.length ? "nothing-found-unreadable" : "nothing-to-stop",
        value: { stopped: [], ...(skippedForeign.length ? { skippedForeign } : {}), trackUrl: consolePage },
        warnings: unreadNotes,
        hint: unreadNotes.length
          ? "No sessions registered in this server and nothing readable on disk, but part of the record could not be read, so nothing is known to be stopped."
          : "No sessions registered in this server, no session markers on disk, and no carrier left in any project this machine recorded. Nothing to stop.",
      });
    }

    const unstopped = outcomes.filter((o) => !o.stopped);

    return envelope({
      ...okOrRefusal(unstopped.length === 0, () => ({
        code: "E_STOP_INCOMPLETE",
        message: `${unstopped.length} of ${outcomes.length} sessions were not stopped: ${unstopped.map((o) => `${o.browser} on ${o.projectPath}`).join("; ")}.`,
        hint: "warnings says why for each. Call extension_stop with that projectPath and browser to try one again.",
      })),
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

  let projectPath = args.projectPath;
  const unreadWarnings: Array<string | null> = [];

  if (!projectPath) {
    const only = onlyLiveSession();
    const unreadable = only.unreadable
      ? `Session markers could not be fully read: ${only.unreadable}; a session recorded there may still be running.`
      : null;

    if (only.kind === "none") {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-session",
        error: {
          code: "E_NO_SESSION",
          message: "No live session is known to this server, so there is nothing to stop without a projectPath.",
        },
        value: { sessions: [], trackUrl: consolePage },
        warnings: [unreadable],
        hint: "Nothing was stopped. Pass the projectPath used with extension_dev or extension_start to stop a session this server did not record, or all: true to sweep every marker on disk.",
      });
    }

    if (only.kind === "many") {
      return envelope({
        ok: false,
        command: schema.name,
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          message: `projectPath is required because sessions for ${only.sessions.length} projects are live: ${describeGroups(only.sessions)}.`,
        },
        value: { sessions: only.sessions, trackUrl: consolePage },
        warnings: [unreadable],
        hint: `Nothing was stopped. Call extension_stop again with projectPath set to one of: ${only.sessions.map((g) => g.projectPath).join(", ")}; or pass all: true with confirm: true to end them all.`,
      });
    }

    projectPath = only.projectPath;
    unreadWarnings.push(unreadable);
  }

  const ambiguous = ambiguousSessionRefusal(schema.name, projectPath, args.browser);
  if (ambiguous) return ambiguous;

  const { browser } = resolveSessionBrowser(projectPath, args.browser);
  const outcome = await stopOne(projectPath, browser);

  return envelope({
    ...okOrRefusal(outcome.stopped, () => notStoppedRefusal(outcome)),
    command: schema.name,
    status:
      outcome.pid === null
        ? "not-found"
        : outcome.stopped
          ? "stopped"
          : "still-alive",
    value: { ...outcome, trackUrl: consolePage },
    warnings: [...unreadWarnings, outcome.stopped ? null : outcome.detail],
  });
}
