// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type PidState = "alive" | "dead" | "foreign";

export const PLAUSIBLE_SESSION_BINARY =
  /chrom|edge|brave|opera|vivaldi|yandex|firefox|waterfox|librewolf|zen|floorp|safari|node|electron|extension|\bnp[mx]\b/i;

/* @invariant A PID WHOSE START TIME MATCHES THE RECORD IS THE SESSION'S, WHATEVER
 * IT CALLS ITSELF. A process chooses its own title: on Linux the engine's
 * Node process read "MainThread", which is no browser and no "node", so on
 * 2026-11-18 (ledger 937) extension_stop called the session's own PID
 * foreign, signalled nothing and left the server up, though the start time
 * matched the session record. The start time is the evidence against a reused
 * PID: a recorded start time that can be read decides alone, alive when it
 * matches and dead when it differs. The title is asked only when there is no
 * start time to compare (none recorded, or the process table would not give
 * one), and then the executable the kernel names counts beside the title,
 * since a process cannot rename that.
 */

/* @invariant A TITLE npm exec WROTE IS READ BY ITS FIRST WORD. npm sets its
 * process title to its whole command ("npm exec extension@latest dev ..."),
 * and Linux then serves that as one argument with no NUL between the words,
 * so the base name of "argv0" was whatever followed the last slash of a URL
 * or a path in it: on 2026-11-18 (ledger 943) a session started through npm
 * exec read as "start.html?ref=nav --allow-control --allow-eval" and, cut to
 * the kernel's 15 characters, as "npm exec extens", both foreign. A command
 * line with no NUL separator and a space in it is split on whitespace and
 * named by its first word, with the old base name kept beside it for a lone
 * path that has a space, and npm and npx count as session binaries.
 */

export interface WindowsProcessRow {
  pid: number;
  name: string;
  commandLine: string;
}

export function readWindowsProcessTable(): WindowsProcessRow[] | null {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    const rows: WindowsProcessRow[] = [];

    for (const line of out.split(/\r?\n/)) {
      const [pidText, name = "", ...rest] = line.split("\t");
      const pid = Number.parseInt(pidText ?? "", 10);

      if (Number.isInteger(pid) && pid > 0) {
        rows.push({ pid, name, commandLine: rest.join("\t") });
      }
    }

    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function windowsImageName(pid: number): string {
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    const match = /^"([^"]+)","(\d+)"/m.exec(out);

    return match && Number(match[2]) === pid ? match[1] : "";
  } catch {
    return "";
  }
}

export function commandLineNames(cmdline: string): string[] {
  let end = cmdline.length;

  while (end > 0 && cmdline.charCodeAt(end - 1) === 0) end -= 1;

  const args = cmdline.slice(0, end).split("\0");
  const argv0 = args[0] ?? "";
  if (!argv0.trim()) return [];
  if (args.length > 1 || !/\s/.test(argv0.trim())) return [path.basename(argv0)];

  const firstWord = argv0.trim().split(/\s+/)[0];

  return [...new Set([path.basename(firstWord), path.basename(argv0)])].filter(Boolean);
}

function processNames(pid: number): string[] {
  if (process.platform === "win32") return [windowsImageName(pid)].filter(Boolean);

  try {
    const names = commandLineNames(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    if (names.length > 0) return names;
  } catch {
  }

  try {
    return [
      execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    ].filter(Boolean);
  } catch {
    return [];
  }
}

export function processCommand(pid: number): string {
  return processNames(pid)[0] ?? "";
}

export function namedLikeSessionProcess(pid: number): boolean {
  return processNames(pid).some((name) => PLAUSIBLE_SESSION_BINARY.test(name));
}

const SAME_START_TOLERANCE_MS = 2_000;

function isoStart(text: string): string | null {
  const parsed = Date.parse(text.trim());

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const WINDOWS_START_TIME_READ_MS = 10_000;

function windowsProcessStartTimes(pids: number[]): Map<number, string> {
  const found = new Map<number, string>();
  const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");

  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CreationDate.ToUniversalTime().ToString('o'))" }`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: WINDOWS_START_TIME_READ_MS },
    );

    for (const line of out.split(/\r?\n/)) {
      const [pidText, stamp = ""] = line.split("\t");
      const pid = Number.parseInt(pidText ?? "", 10);
      const iso = isoStart(stamp);

      if (Number.isInteger(pid) && pid > 0 && iso) found.set(pid, iso);
    }
  } catch {
  }

  return found;
}

/* @invariant ON LINUX THE KERNEL ANSWERS WHAT ps AND pgrep WOULD. A slim
 * container image ships neither command, so no start time was ever recorded
 * for a session there and the search for surviving browser processes could
 * not run: extension_stop ended the session and still answered
 * E_STOP_INCOMPLETE, on every call (ledger 949). A PID that ps gives no
 * start time for is read from /proc/<pid>/stat (field 22, clock ticks since
 * boot, at the 100 a second Linux reports to user space) and the btime line
 * of /proc/stat, the sum ps itself prints, and extension_stop reads the
 * command lines under /proc when pgrep cannot run.
 */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export const procfs = { root: "/proc" };

export function linuxParentFromStat(stat: string): number | null {
  const parent = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[1]);

  return Number.isInteger(parent) && parent >= 0 ? parent : null;
}

export function kernelProcessParents(): Map<number, number> | null {
  let names: string[];

  try {
    names = fs.readdirSync(procfs.root);
  } catch {
    return null;
  }

  const parents = new Map<number, number>();

  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;

    try {
      const parent = linuxParentFromStat(fs.readFileSync(path.join(procfs.root, name, "stat"), "utf8"));

      if (parent !== null) parents.set(Number(name), parent);
    } catch {
    }
  }

  return parents;
}

export function kernelCommandLine(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(path.join(procfs.root, String(pid), "cmdline"), "utf8");
    let end = raw.length;

    while (end > 0 && raw.charCodeAt(end - 1) === 0) end -= 1;

    const args = raw.slice(0, end).split("\0");

    if (args.length === 1 && !args[0].trim()) return null;

    return args.length === 1 ? args[0].trim().split(/\s+/) : args;
  } catch {
    return null;
  }
}

function linuxBootTimeMs(): number | null {
  try {
    const seconds = /^btime\s+(\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1];

    return seconds ? Number(seconds) * 1000 : null;
  } catch {
    return null;
  }
}

export function linuxStateFromStat(stat: string): string | null {
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[0] || null;
}

export function linuxStartFromStat(stat: string, bootTimeMs: number): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
  const ticks = Number(fields[19]);
  if (fields.length < 20 || !Number.isFinite(ticks) || ticks < 0) return null;

  return new Date(bootTimeMs + Math.round((ticks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND)).toISOString();
}

function linuxProcessStartedAt(pid: number): string | null {
  const boot = linuxBootTimeMs();
  if (boot === null) return null;

  try {
    return linuxStartFromStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"), boot);
  } catch {
    return null;
  }
}

/* @invariant A PROCESS THAT EXITED AND WAS NEVER REAPED IS DEAD. A zombie
 * keeps its PID and its start time, and answers signal 0, until its parent
 * waits for it; in a container whose PID 1 does not reap, that is forever.
 * Read as alive, an engine or package manager that had been handed the
 * install record held it after it exited, so every build answered "still
 * installing" with no end, and extension_stop counted the same process as a
 * survivor. The state is read where the start time is: the stat column of
 * the same ps call, and the third field of /proc/<pid>/stat on Linux.
 */
interface ProcessRow {
  state: string;
  startedAt: string | null;
}

function posixProcessRows(pids: number[]): Map<number, ProcessRow> {
  const found = new Map<number, ProcessRow>();
  let out = "";

  try {
    out = execFileSync("ps", ["-o", "pid=,stat=,lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    out = typeof stdout === "string" ? stdout : "";
  }

  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);

    if (Number.isInteger(pid) && pid > 0) found.set(pid, { state: match[2], startedAt: isoStart(match[3].trimEnd()) });
  }

  return found;
}

function posixProcessStartTimes(pids: number[]): Map<number, string> {
  const found = new Map<number, string>();

  for (const [pid, row] of posixProcessRows(pids)) {
    if (row.startedAt) found.set(pid, row.startedAt);
  }

  if (process.platform === "linux") {
    for (const pid of pids) {
      const iso = found.has(pid) ? null : linuxProcessStartedAt(pid);
      if (iso) found.set(pid, iso);
    }
  }

  return found;
}

export function processStartTimes(pids: number[]): Map<number, string> {
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (wanted.length === 0) return new Map();

  return process.platform === "win32"
    ? windowsProcessStartTimes(wanted)
    : posixProcessStartTimes(wanted);
}

export function processStartedAt(pid: number): string | null {
  return processStartTimes([pid]).get(pid) ?? null;
}

export function sameProcessStart(recorded: string, current: string): boolean {
  const a = Date.parse(recorded);
  const b = Date.parse(current);

  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_START_TOLERANCE_MS;
}

export function startedAsRecorded(pid: number, startedAt: string | null | undefined): boolean {
  if (!startedAt) return false;

  const current = processStartedAt(pid);

  return current !== null && sameProcessStart(startedAt, current);
}

function processExecutable(pid: number): string {
  if (process.platform !== "linux") return "";

  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ""));
  } catch {
    return "";
  }
}

export function plausibleSessionProcess(pid: number): boolean {
  const names = [...processNames(pid), processExecutable(pid)].filter(Boolean);

  return names.length === 0 || names.some((name) => PLAUSIBLE_SESSION_BINARY.test(name));
}

function linuxZombie(pid: number): boolean {
  if (process.platform !== "linux") return false;

  try {
    return linuxStateFromStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8")) === "Z";
  } catch {
    return false;
  }
}

export function pidRecycled(pid: number, startedAt: string | null | undefined): boolean {
  if (!startedAt) return false;

  const current = processStartedAt(pid);

  return current !== null && !sameProcessStart(startedAt, current);
}

export function pidState(pid: number, startedAt?: string | null): PidState {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPERM") return "dead";

    return pidRecycled(pid, startedAt) ? "dead" : "foreign";
  }

  const row = process.platform === "win32" || process.platform === "linux" ? undefined : posixProcessRows([pid]).get(pid);

  if (row ? row.state.startsWith("Z") : linuxZombie(pid)) return "dead";

  const current = startedAt ? (row?.startedAt ?? processStartedAt(pid)) : null;
  if (startedAt && current !== null) return sameProcessStart(startedAt, current) ? "alive" : "dead";

  return plausibleSessionProcess(pid) ? "alive" : "foreign";
}

export function describeRecycledPid(pid: number, startedAt: string | null | undefined): string | null {
  if (!startedAt) return null;

  const current = processStartedAt(pid);
  if (current === null || sameProcessStart(startedAt, current)) return null;

  return `pid ${pid} now belongs to a process started at ${current}, not the session process started at ${startedAt}`;
}

export function describeForeignPid(pid: number): string {
  const command = processCommand(pid);

  return command
    ? `pid ${pid} now belongs to "${command}", which is not a session process`
    : `pid ${pid} is a process this user may not signal, so it is not this session's`;
}
