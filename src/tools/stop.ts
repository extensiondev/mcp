import fs from "node:fs";
import path from "node:path";
import type { ReadyContract } from "../lib/types";
import {
  getSession,
  listSessions,
  removeSession,
} from "../lib/process-manager";

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
        default: "chrome",
        description:
          "Browser of the session to stop (matches the browser passed to extension_dev/extension_start)",
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
  detail: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Signal the whole process group (the spawn is detached, so the CLI leads its
// own group and the group signal reaches the dev server AND the browser it
// launched). Fall back to a single-pid signal for platforms/sessions where
// group signaling is unavailable.
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

// The MCP server may have restarted since the session began, losing the
// in-memory registry. The ready.json contract the CLI writes carries the pid,
// so a stop can still find the process.
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
    return {
      projectPath,
      browser,
      pid: null,
      stopped: false,
      detail:
        "No known session for this project/browser (nothing registered in this server and no ready.json contract found).",
    };
  }

  let detail: string;
  if (!isAlive(pid)) {
    detail = "Process was already gone; cleaned up session records.";
  } else {
    signal(pid, "SIGTERM");
    // Give the CLI a moment to shut down its browser and server cleanly,
    // then escalate if the tree is still alive.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (isAlive(pid)) {
      signal(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    detail = isAlive(pid)
      ? "Sent SIGTERM and SIGKILL but the process still reports alive; it may be exiting."
      : "Terminated.";
  }

  removeSession(projectPath, browser);
  // Drop the stale ready contract so a later extension_wait cannot report a
  // dead session as ready.
  try {
    fs.rmSync(readyJsonPath(projectPath, browser), { force: true });
  } catch {
    // dist may be read-only or already gone — not worth failing the stop
  }

  return { projectPath, browser, pid, stopped: !isAlive(pid), detail };
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

  const outcome = await stopOne(args.projectPath, args.browser ?? "chrome");
  return JSON.stringify(outcome);
}
