import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runExtensionCli, spawnExtensionCli, type SpawnedCli } from "../lib/exec";


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

    expect(live.child.stdout).toBeNull();
    expect(live.child.stderr).toBeNull();

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

  posixOnly(
    "survives a spawn failure instead of crashing the server on an unhandled error event",
    async () => {
      const previousPath = process.env.PATH;
      process.env.PATH = "/nonexistent-mcp-test-bin";
      try {
        const spawned = spawnExtensionCli(["--version"]);
        await new Promise((r) => setTimeout(r, 300));
        expect(spawned.child.pid).toBeUndefined();
        expect(spawned.spawnError?.()).toBeInstanceOf(Error);
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );
});

describe("runExtensionCli outer kill timer", () => {
  posixOnly(
    "gives the engine's own --timeout envelope headroom to land before the SIGTERM",
    async () => {
      const project = fakeProject('sleep 1.5; echo "engine timeout frame"');

      const result = await runExtensionCli(["eval", "1"], {
        cwd: project,
        timeoutMs: 500,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("engine timeout frame");
    },
    15_000,
  );
});
