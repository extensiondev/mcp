import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawnExtensionCli, type SpawnedCli } from "../lib/exec";

// detach-outlives-stdio: `detached: true` alone never made a session survive
// the MCP process, because piped stdio dies with the parent and the next log
// write kills the child with EPIPE. The mechanism that actually makes a
// session outlive the MCP is (a) file-backed stdio and (b) its own process
// group. Pin both, against the REAL spawnExtensionCli via a project-local fake
// `extension` binary, so a refactor back to pipes fails loudly here instead of
// as a "dev server dies uncleanly" persona finding.

const cleanups: Array<() => void> = [];
let live: SpawnedCli | undefined;

function fakeProject(binScript: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-exec-detach-"));
  const binDir = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "extension");
  fs.writeFileSync(bin, `#!/bin/sh\n${binScript}\n`);
  fs.chmodSync(bin, 0o755);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  if (live?.child.pid) {
    try {
      // Negative pid: kill the detached process GROUP, not just the leader.
      process.kill(-live.child.pid, "SIGKILL");
    } catch {
      try {
        live.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  live = undefined;
  for (const fn of cleanups.splice(0)) fn();
});

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("spawnExtensionCli detach contract", () => {
  posixOnly("gives the child file-backed stdio, not pipes", async () => {
    const project = fakeProject('echo "session log line"; sleep 60');
    live = spawnExtensionCli(["dev", project], { projectDir: project });

    // No pipes: nothing for a dying MCP process to close on the child.
    expect(live.child.stdout).toBeNull();
    expect(live.child.stderr).toBeNull();

    // The output still reaches us, through the log file.
    await new Promise((r) => setTimeout(r, 500));
    expect(live.readOutput()).toContain("session log line");
    expect(fs.readFileSync(live.logPath, "utf8")).toContain("session log line");
  });

  posixOnly("puts the child in its own process group", async () => {
    const project = fakeProject("sleep 60");
    live = spawnExtensionCli(["dev", project], { projectDir: project });
    const pid = live.child.pid!;

    const pgid = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    );
    const ownPgid = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      }).trim(),
    );
    expect(pgid).toBe(pid);
    expect(pgid).not.toBe(ownPgid);
  });
});
