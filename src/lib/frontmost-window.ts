// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawnSync } from "node:child_process";

const PROBE_MS = 2_000;

export type FrontmostRead = { app: string; pid: number | null } | { unavailable: string };

function run(args: string[]): { out: string } | { failed: string } {
  const result = spawnSync("lsappinfo", args, { encoding: "utf8", timeout: PROBE_MS });

  if (result.error) return { failed: `lsappinfo ${args[0]} failed: ${result.error.message}` };
  if (result.status !== 0) return { failed: `lsappinfo ${args[0]} exited ${result.status}` };

  return { out: result.stdout };
}

export function readFrontmostApp(platform: NodeJS.Platform = process.platform): FrontmostRead {
  if (platform !== "darwin") return { unavailable: "this server reads the frontmost app on macOS only" };

  const front = run(["front"]);
  if ("failed" in front) return { unavailable: front.failed };

  const asn = front.out.trim();
  if (!asn) return { unavailable: "lsappinfo front named no frontmost app" };

  const info = run(["info", "-only", "name", "-only", "pid", asn]);
  if ("failed" in info) return { unavailable: info.failed };

  const app = /"LSDisplayName"="([^"]*)"/.exec(info.out)?.[1]?.trim();
  if (!app) return { unavailable: `lsappinfo info gave no name for ${asn}` };

  const pid = /"pid"=(\d+)/.exec(info.out)?.[1];

  return { app, pid: pid ? Number(pid) : null };
}
