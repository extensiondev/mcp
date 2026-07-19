// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ReadyContract } from "../lib/types";
import {
  getSession,
  listSessions,
  removeSession,
} from "../lib/process-manager";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_stop",
  description:
    "Stop a running dev, start, or preview session: terminates the dev server and the browser it launched. Counterpart to extension_dev/extension_start. Call it when you are done verifying so sessions do not accumulate.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        description:
          "Browser of the session to stop (matches the browser passed to extension_dev/extension_start). Defaults to the one live session for this project when omitted, instead of assuming chrome.",
      },
      all: {
        type: "boolean",
        default: false,
        description:
          "Stop every session this server started, across projects and browsers. When true, projectPath/browser are ignored.",
      },
    },
    required: [],
  },
};

interface StopOutcome {
  projectPath: string;
  browser: string;
  pid: number | null;
  stopped: boolean;
  reaped: number[];
  detail: string;
}

// The dev-server pid does not own the launched browser: it runs under its own
// user-data-dir (dist/extension-profile-<browser>) and, on Firefox especially,
// survives the CLI dying. Killing only the dev pid left orphan browser
// processes reporting stopped:true. Find every process whose command line
// references this project's browser profile and terminate them too.
function profileProcessPids(projectPath: string, browser: string): number[] {
  const marker = path.resolve(
    projectPath,
    "dist",
    `extension-profile-${browser}`,
  );
  try {
    const out = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    // pgrep exits non-zero when nothing matches (or is unavailable on Windows).
    return [];
  }
}

function reapProfileProcesses(projectPath: string, browser: string): number[] {
  const pids = profileProcessPids(projectPath, browser);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  return pids;
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

function readyJsonPath(projectPath: string, browser: string): string {
  return path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );
}

function pidFromReadyContract(
  projectPath: string,
  browser: string,
): number | null {
  try {
    const raw = fs.readFileSync(readyJsonPath(projectPath, browser), "utf8");
    const contract: ReadyContract = JSON.parse(raw);
    return typeof contract.pid === "number" ? contract.pid : null;
  } catch {
    return null;
  }
}

async function stopOne(
  projectPath: string,
  browser: string,
): Promise<StopOutcome> {
  const session = getSession(projectPath, browser);
  const pid = session?.pid ?? pidFromReadyContract(projectPath, browser);

  if (pid == null) {
    // Even with no registered dev pid, an orphaned browser may still be running
    // under the profile dir; reap those before reporting nothing to do.
    const reaped = reapProfileProcesses(projectPath, browser);
    return {
      projectPath,
      browser,
      pid: null,
      stopped: reaped.length === 0 ? false : true,
      reaped,
      detail:
        reaped.length === 0
          ? "No known session for this project/browser (nothing registered in this server and no ready.json contract found)."
          : `No dev pid on record, but reaped ${reaped.length} orphaned browser process(es) from the profile dir.`,
    };
  }

  let detail: string;
  if (!isAlive(pid)) {
    detail = "Process was already gone; cleaned up session records.";
  } else {
    signal(pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (isAlive(pid)) {
      signal(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    detail = isAlive(pid)
      ? "Sent SIGTERM and SIGKILL but the process still reports alive; it may be exiting."
      : "Terminated.";
  }

  // Reap the browser process tree launched under the profile dir; the dev pid
  // dying does not take these with it (Firefox in particular detaches).
  const reaped = reapProfileProcesses(projectPath, browser);

  removeSession(projectPath, browser);
  try {
    fs.rmSync(readyJsonPath(projectPath, browser), { force: true });
  } catch {
  }

  // Only claim stopped when the dev pid is gone AND no profile process survived
  // the reap. A survivor means the caller must not trust the machine is quiet.
  const survivors = profileProcessPids(projectPath, browser);
  const stopped = !isAlive(pid) && survivors.length === 0;
  if (survivors.length) {
    detail += ` Warning: ${survivors.length} browser process(es) still alive after reap (pids ${survivors.join(", ")}).`;
  } else if (reaped.length) {
    detail += ` Reaped ${reaped.length} browser process(es).`;
  }

  return { projectPath, browser, pid, stopped, reaped, detail };
}

export async function handler(args: {
  projectPath?: string;
  browser?: string;
  all?: boolean;
}): Promise<string> {
  if (args.all) {
    const sessions = listSessions();
    if (sessions.length === 0) {
      return JSON.stringify({
        stopped: [],
        message: "No sessions registered in this server.",
      });
    }
    const outcomes: StopOutcome[] = [];
    for (const s of sessions) {
      outcomes.push(await stopOne(s.projectPath, s.browser));
    }
    return JSON.stringify({ stopped: outcomes });
  }

  if (!args.projectPath) {
    return JSON.stringify({
      error:
        "projectPath is required unless all=true. Pass the same projectPath used with extension_dev/extension_start.",
    });
  }

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const outcome = await stopOne(args.projectPath, browser);
  return JSON.stringify(outcome);
}
