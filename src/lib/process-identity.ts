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
      { encoding: "utf8", windowsHide: true },
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

function posixProcessStartTimes(pids: number[]): Map<number, string> {
  const found = new Map<number, string>();
  let out = "";

  try {
    out = execFileSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    out = typeof stdout === "string" ? stdout : "";
  }

  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const iso = isoStart(match[2].trimEnd());

    if (Number.isInteger(pid) && pid > 0 && iso) found.set(pid, iso);
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

  const current = startedAt ? processStartedAt(pid) : null;
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
