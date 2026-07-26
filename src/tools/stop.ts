// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PATH } from "../lib/common-schema";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ReadyContract } from "../lib/types";
import {
  getSession,
  listSessionMarkers,
  listSessions,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import { resolveSessionBrowser } from "../lib/session-browser";
import { removeCarrier } from "../lib/carrier";

export const schema = {
  name: "extension_stop",
  description:
    "Stop a session that extension_dev or extension_start is running: terminates the server and the browser it launched, and removes the live-preview carrier if extension_dev placed one. Covers extension_start build:false too, which the registry still records as a preview session. Call it when you are done verifying so sessions do not accumulate.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: {
        type: "string",
        description:
          "Browser of the session to stop. Defaults to the single live session for this project rather than assuming chrome.",
      },
      all: {
        type: "boolean",
        default: false,
        description:
          "Stop every known session across projects and browsers, found from this server's registry AND the on-disk markers earlier runs left, so it still works after an MCP restart. projectPath/browser are then ignored.",
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
  carrierRemoved?: string;
}

function cleanCarrier(projectPath: string): { carrierRemoved?: string } {
  const removal = removeCarrier(projectPath);
  return removal.removed ? { carrierRemoved: removal.path } : {};
}

function pgrepPids(pattern: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

function sessionProcessPids(projectPath: string): number[] {
  const resolved = path.resolve(projectPath);
  const pids = new Set<number>();
  for (const marker of [`extension dev ${resolved}`, path.join(resolved, "dist")]) {
    for (const pid of pgrepPids(marker)) pids.add(pid);
  }
  return [...pids];
}

function reapSessionProcesses(projectPath: string): number[] {
  const pids = sessionProcessPids(projectPath);
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

export async function stopOne(
  projectPath: string,
  browser: string,
): Promise<StopOutcome> {
  const session = getSession(projectPath, browser);
  const pid = session?.pid ?? pidFromReadyContract(projectPath, browser);

  if (pid == null) {
    const reaped = reapSessionProcesses(projectPath);
    removeSessionMarker(projectPath, browser);
    return {
      projectPath,
      browser,
      pid: null,
      stopped: reaped.length === 0 ? false : true,
      reaped,
      ...cleanCarrier(projectPath),
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

  const reaped = reapSessionProcesses(projectPath);

  removeSession(projectPath, browser);
  removeSessionMarker(projectPath, browser);
  try {
    fs.rmSync(readyJsonPath(projectPath, browser), { force: true });
  } catch {
  }

  const survivors = sessionProcessPids(projectPath);
  const stopped = !isAlive(pid) && survivors.length === 0;
  if (survivors.length) {
    detail += ` Warning: ${survivors.length} browser process(es) still alive after reap (pids ${survivors.join(", ")}).`;
  } else if (reaped.length) {
    detail += ` Reaped ${reaped.length} browser process(es).`;
  }

  return {
    projectPath,
    browser,
    pid,
    stopped,
    reaped,
    detail,
    ...cleanCarrier(projectPath),
  };
}

export async function handler(args: {
  projectPath?: string;
  browser?: string;
  all?: boolean;
}): Promise<string> {
  if (args.all) {
    const candidates = new Map<string, { projectPath: string; browser: string }>();
    for (const s of listSessions()) {
      candidates.set(`${path.resolve(s.projectPath)}::${s.browser}`, s);
    }
    for (const m of listSessionMarkers()) {
      const key = `${path.resolve(m.projectPath)}::${m.browser}`;
      if (!candidates.has(key)) candidates.set(key, m);
    }
    if (candidates.size === 0) {
      return JSON.stringify({
        stopped: [],
        message:
          "No sessions registered in this server and no session markers on disk. Nothing to stop.",
      });
    }
    const outcomes: StopOutcome[] = [];
    for (const c of candidates.values()) {
      outcomes.push(await stopOne(c.projectPath, c.browser));
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
