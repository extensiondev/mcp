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
  /chrom|edge|brave|opera|vivaldi|yandex|firefox|waterfox|librewolf|zen|floorp|safari|node|electron|extension/i;

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

export function processCommand(pid: number): string {
  if (process.platform === "win32") return windowsImageName(pid);

  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const argv0 = cmdline.split("\0")[0];
    if (argv0) return path.basename(argv0);
  } catch {
  }

  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
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
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    out = typeof stdout === "string" ? stdout : "";
  }

  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const iso = isoStart(match[2]);

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

  if (pidRecycled(pid, startedAt)) return "dead";

  const command = processCommand(pid);
  if (command && !PLAUSIBLE_SESSION_BINARY.test(command)) return "foreign";

  return "alive";
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
