// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawnSync } from "node:child_process";

export const SAFARI_WEB_EXTENSION_PROTOCOL = "com.apple.Safari.web-extension";

const PROBE_MS = 3000;

const ACCESSIBILITY_PROBE = "tell application \"System Events\" to count of windows of (first application process whose frontmost is true)";

export interface AutomationProbe {
  ok: boolean;
  detail: string;
}

export interface SafariEnableProbes {
  platform: () => string;
  automation: () => AutomationProbe;
  safariRunning: () => boolean | null;
  pluginkitList: () => string | null;
  hostApp: () => string;
}

function run(bin: string, args: string[]): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout: PROBE_MS, maxBuffer: 4 * 1024 * 1024 });

  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "").replace(/^.*ApplePersistence=NO\n?/m, ""),
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
  };
}

export function hostAppFromProcessTable(table: string, startPid: number, env: NodeJS.ProcessEnv): string {
  const rows = new Map<number, { ppid: number; command: string }>();

  for (const line of table.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), command: match[3]! });
  }

  for (let pid = startPid, hops = 0; hops < 24 && pid > 1; hops += 1) {
    const row = rows.get(pid);
    if (!row) break;

    const app = row.command.match(/([^/]+)\.app\/Contents\/MacOS\//);
    if (app) return app[1]!;

    pid = row.ppid;
  }

  const term = String(env.TERM_PROGRAM ?? "").trim();
  if (term === "Apple_Terminal") return "Terminal";
  if (term === "iTerm.app") return "iTerm";

  return term || "the terminal app that runs this server";
}

export const safariEnableProbes: SafariEnableProbes = {
  platform: () => process.platform,
  automation: () => {
    const result = run("osascript", ["-e", ACCESSIBILITY_PROBE]);

    if (result.timedOut) return { ok: false, detail: `osascript did not answer within ${PROBE_MS / 1000} s` };
    if (result.status === 0 && result.stdout.trim()) return { ok: true, detail: "" };

    return { ok: false, detail: (result.stderr.trim() || result.stdout.trim()) || `osascript exited ${result.status}` };
  },
  safariRunning: () => {
    const result = run("pgrep", ["-x", "Safari"]);

    return result.status === 0 ? true : result.status === 1 ? false : null;
  },
  pluginkitList: () => {
    const result = run("pluginkit", ["-m", "-v", "-p", SAFARI_WEB_EXTENSION_PROTOCOL]);

    return result.status === 0 ? result.stdout : null;
  },
  hostApp: () => {
    const result = run("ps", ["-Ao", "pid=,ppid=,command="]);

    return hostAppFromProcessTable(result.status === 0 ? result.stdout : "", process.pid, process.env);
  },
};
