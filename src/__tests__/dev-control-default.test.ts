// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";

const spawned: ChildProcess[] = [];
const cliArgsSeen: string[][] = [];

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  spawned.push(child);

  return {
    child,
    logPath,
    readOutput: () => {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: (args: string[]) => {
      cliArgsSeen.push(args);

      return fakeCli();
    },
  };
});

const dev = await import("../tools/dev");
const { removeSession } = await import("../lib/process-manager");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-control-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  cliArgsSeen.length = 0;

  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev carries the control channel unless asked not to", () => {
  it("passes --allow-control to the engine on a plain call and reports the control verbs unlocked", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.status).toBe("started");
    expect(cliArgsSeen[0]).toContain("--allow-control");
    expect(cliArgsSeen[0]).not.toContain("--allow-eval");
    expect(result.value.capabilities).toMatchObject({
      allowControl: true,
      allowEval: false,
      unlocked: "storage, reload, open, dom_snapshot",
    });

    expect(result.hint).not.toMatch(/Control channel is OFF/);
  }, 15_000);

  it("passes no control flag and reports the session read-only when allowControl is false", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, allowControl: false }));

    expect(result.status).toBe("started");
    expect(cliArgsSeen[0]).not.toContain("--allow-control");
    expect(cliArgsSeen[0]).not.toContain("--allow-eval");
    expect(result.value.capabilities).toMatchObject({
      allowControl: false,
      allowEval: false,
      unlocked: "none (read-only: logs, inspect, wait, doctor)",
    });

    expect(result.hint).toMatch(/Control channel is OFF/);
    expect(result.hint).toMatch(/allowControl: false/);
  }, 15_000);

  it("passes both flags when allowEval is true, since eval implies control", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project, allowEval: true }));

    expect(result.status).toBe("started");
    expect(cliArgsSeen[0]).toContain("--allow-control");
    expect(cliArgsSeen[0]).toContain("--allow-eval");
    expect(result.value.capabilities).toMatchObject({
      allowControl: true,
      allowEval: true,
      unlocked: "storage, reload, open, dom_snapshot, eval",
    });
  }, 15_000);
});
