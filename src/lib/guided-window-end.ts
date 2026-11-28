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
  list(): string | null;
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
  list: () => {
    try {
      return execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
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

/* @invariant THE BROWSER ON THE PROFILE NAMES THE WINDOW WHEN THE MARKER
 * DOES NOT (MCP ledger 1151). The running marker can name a preview that
 * already exited while the browser of an earlier one still holds the
 * profile; a fresh preview on that profile dies at once and the answer
 * claimed a window. A live marker PID decides; otherwise the process whose
 * --user-data-dir is exactly this profile is the browser, and its process
 * group is the preview that started it.
 */
export function runningOwner(profileDir: string, markerPid: unknown, proc: GuidedProcess = guidedProcess): number | null {
  if (typeof markerPid === "number" && Number.isInteger(markerPid) && markerPid > 1 && proc.signal(markerPid, 0)) return markerPid;
  if (proc.platform === "win32") return null;

  const flag = `--user-data-dir=${profileDir}`;
  const row = (proc.list() ?? "").split("\n").map((line) => line.trim().split(/\s+/)).find((words) => words.slice(2).includes(flag));
  const group = Number(row?.[1] ?? 0);

  return group > 1 ? group : null;
}

export function launchWord(launched: { reused: boolean; replaced?: true; reloaded?: true; reloadMissed?: string }): string {
  if (launched.reloaded) return "The guided window already open ran an older extension.dev tools, so the current one was reloaded in place in that same window, which keeps every sign-in in it, and that window took the page:";

  if (launched.replaced) {
    const why = launched.reloadMissed ? ` because the current extension.dev tools could not be reloaded in place (${launched.reloadMissed})` : "";

    return `Closed the guided window it had opened, which ran an older extension.dev tools, and opened it again with the current one${why}. The restart signed the person out of App Store Connect, which keeps its sign-in only while the browser runs, so they sign in there again with two-factor; Partner Center and Firefox Add-ons ask again too unless their sign-in was kept with "stay signed in", and the extension.dev console sign-in stays:`;
  }

  return launched.reused ? "The guided browser already running took the page:" : "Opened";
}

export function launchFacts(launched: { replaced?: true; reloaded?: true; reloadMissed?: string }): Record<string, unknown> {
  if (launched.reloaded) return { reloaded: true };

  return launched.replaced ? { replaced: true, signInsLost: ["App Store Connect"], ...(launched.reloadMissed ? { reloadMissed: launched.reloadMissed } : {}) } : {};
}
