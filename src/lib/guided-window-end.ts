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

export interface GuidedProcess {
  table(pid: number): string | null;
  signal(pid: number, signal: NodeJS.Signals | 0): boolean;
  wait(ms: number): void;
  platform: NodeJS.Platform;
}

export const guidedProcess: GuidedProcess = {
  table: (pid) => {
    try {
      return execFileSync("ps", ["-o", "pgid=,command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  },
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);

      return true;
    } catch {
      return false;
    }
  },
  wait: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  platform: process.platform,
};

/* @invariant THE MCP ENDS ONLY THE GUIDED WINDOW IT STARTED (MCP ledger
 * 1149). The marker's PID is ended only when the process table still shows
 * it leading its own group as the Extension.js preview of this very profile,
 * so a PID the system gave to another program since is never signalled; the
 * whole group goes, which is that preview and the browser it opened, and no
 * other window. The restored tab list goes with it so the relaunch opens one
 * tab; cookies and sign-ins stay in the profile.
 */
export function endGuidedWindow(profileDir: string, pid: number, proc: GuidedProcess = guidedProcess): boolean {
  if (proc.platform === "win32" || !Number.isInteger(pid) || pid <= 1) return false;

  const row = proc.table(pid);
  const match = row?.match(/^(\d+)\s+(.*)$/s);
  if (!match || Number(match[1]) !== pid) return false;

  const command = match[2] ?? "";
  const words = command.split(/\s+/);
  const at = words.indexOf("--profile");
  if (!words.includes("preview") || at < 0 || words[at + 1] !== profileDir) return false;

  proc.signal(-pid, "SIGTERM");

  for (let waited = 0; waited < 10_000 && proc.signal(-pid, 0); waited += 200) proc.wait(200);

  if (proc.signal(-pid, 0)) proc.signal(-pid, "SIGKILL");

  for (let waited = 0; waited < 3000 && proc.signal(-pid, 0); waited += 200) proc.wait(200);

  if (proc.signal(-pid, 0)) return false;

  fs.rmSync(path.join(profileDir, "Default", "Sessions"), { recursive: true, force: true });

  return true;
}

export function launchWord(launched: { reused: boolean; replaced?: true }): string {
  if (launched.replaced) return "Closed the guided window it had opened, which ran an older extension.dev tools, and opened it again with the current one, sign-ins kept:";

  return launched.reused ? "The guided browser already running took the page:" : "Opened";
}
