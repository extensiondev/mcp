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

/* @invariant
 * A RECORDED PID IS A CLAIM, NOT A SESSION. A session's pid lives on in
 * ready.json and in the tmpdir marker after a crash, a reboot or a server
 * that exited first, and the number is handed to whatever process the OS
 * starts next. Reading `kill(pid, 0)` alone then called that stranger our
 * session: the fork guard refused to start, and `extension_stop` sent it
 * SIGTERM and SIGKILL, process group first. Every reader
 * of a recorded pid now asks what the process IS before it believes the
 * record: alive and plausibly a session process, dead, or foreign (a live
 * process whose command is readable and names nothing a session runs, or
 * one this user may not signal at all). Only "alive" is ever acted on.
 */
export type PidState = "alive" | "dead" | "foreign";

export const PLAUSIBLE_SESSION_BINARY =
  /chrom|edge|brave|opera|vivaldi|yandex|firefox|waterfox|librewolf|zen|floorp|safari|node|electron|extension/i;

export function processCommand(pid: number): string {
  /* Linux ps -o comm= reports the thread name (Node stamps "MainThread"),
     not the binary, so argv[0] from /proc must win where it exists. */
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

export function pidState(pid: number): PidState {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM" ? "foreign" : "dead";
  }
  const command = processCommand(pid);
  if (command && !PLAUSIBLE_SESSION_BINARY.test(command)) return "foreign";
  return "alive";
}

export function describeForeignPid(pid: number): string {
  const command = processCommand(pid);
  return command
    ? `pid ${pid} now belongs to "${command}", which is not a session process`
    : `pid ${pid} is a process this user may not signal, so it is not this session's`;
}
