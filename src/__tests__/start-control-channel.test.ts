import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";

const spawned: ChildProcess[] = [];
const spawnedArgs: string[][] = [];
const bootVerdict: { current: Record<string, unknown> } = {
  current: { kind: "started" },
};
const bootTail: { current: string } = { current: "" };

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
      spawnedArgs.push(args);

      return fakeCli();
    },
  };
});

vi.mock("../lib/boot-verdict", () => ({
  pollBootVerdict: async () => ({
    verdict: bootVerdict.current,
    warnings: [],
    evidenceTail: bootTail.current,
  }),
  bootFailureHint: () => "",
}));

const start = await import("../tools/start");
const { removeSession } = await import("../lib/process-manager");

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-control-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  spawnedArgs.length = 0;
  bootVerdict.current = { kind: "started" };
  bootTail.current = "";

  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeContract(project: string, contract: Record<string, unknown>) {
  const dir = path.join(project, "dist", "extension-js", "chrome");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify(contract));
}

describe("extension_start opens the control channel on a production run", () => {
  it("advertises allowControl and allowEval in its schema", () => {
    const props = start.schema.inputSchema.properties as Record<string, { type?: string }>;

    expect(props.allowControl?.type).toBe("boolean");
    expect(props.allowEval?.type).toBe("boolean");
  });

  it("passes --allow-control to the engine and keeps it off by default", async () => {
    const project = tmpProject();

    await start.handler({ projectPath: project });
    expect(spawnedArgs[0]).not.toContain("--allow-control");
    expect(spawnedArgs[0]).not.toContain("--allow-eval");

    for (const child of spawned.splice(0)) child.kill("SIGKILL");
    removeSession(project, "chrome");
    spawnedArgs.length = 0;

    await start.handler({ projectPath: project, allowControl: true });
    expect(spawnedArgs[0]).toContain("--allow-control");
    expect(spawnedArgs[0]).not.toContain("--allow-eval");
  });

  it("lets allowEval imply allowControl, on preview as well as start", async () => {
    const project = tmpProject();
    const built = path.join(project, "dist", "chrome");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Z" }));

    await start.handler({ projectPath: project, build: false, allowEval: true });

    expect(spawnedArgs[0][0]).toBe("preview");
    expect(spawnedArgs[0]).toContain("--allow-control");
    expect(spawnedArgs[0]).toContain("--allow-eval");
  });

  it("reports the control port and stops saying the control verbs cannot attach", async () => {
    const project = tmpProject();
    writeContract(project, {
      command: "start",
      status: "ready",
      controlPort: 61234,
      instanceId: "inst-1",
      distPath: path.join(project, "dist", "extension-js", "chrome", "controlled"),
    });

    const before = Date.now();
    const contractFile = path.join(project, "dist", "extension-js", "chrome", "ready.json");
    fs.utimesSync(contractFile, new Date(before + 60_000), new Date(before + 60_000));

    const result = JSON.parse(
      await start.handler({ projectPath: project, allowEval: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.allowControl).toBe(true);
    expect(result.value.allowEval).toBe(true);
    expect(result.value.controlPort).toBe(61234);
    expect(result.hint).not.toMatch(/control verbs cannot attach/);
    expect(result.hint).toMatch(/extension_eval/);
    expect(result.hint).toMatch(/extension_reload/);
  });

  it("reads the background attaching to the control channel as the load proof", async () => {
    const { productionLaunchEvidence } = await import("../lib/production-launch");

    const attached = productionLaunchEvidence({
      command: "start",
      controlPort: 61234,
      executorAttachedAt: "2026-10-17T13:56:38.889Z",
    } as never);
    expect(attached.extensionLoaded).toBe(true);
    expect(attached.loadEvidence).toMatch(/control channel at 2026-10-17T13:56:38.889Z/);

    const waiting = productionLaunchEvidence({ command: "start", controlPort: 61234 } as never);
    expect(waiting.extensionLoaded).toBeNull();
    expect(waiting.loadEvidence).not.toMatch(/control verbs cannot attach/);

    const plain = productionLaunchEvidence({ command: "start" } as never);
    expect(plain.extensionLoaded).toBeNull();
    expect(plain.loadEvidence).toMatch(/control verbs cannot attach/);
  });

  it("refuses with the engine it needs when the engine has no control flags", async () => {
    const project = tmpProject();
    bootVerdict.current = { kind: "exited", exitCode: 1, signal: null };
    bootTail.current = "error: unknown option '--allow-control'\n";

    const result = JSON.parse(
      await start.handler({ projectPath: project, allowControl: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("engine-unsupported");
    expect(result.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(result.error.message).toMatch(/--allow-control/);
    expect(result.error.message).toMatch(/4\.1\.33/);
    expect(result.hint).toMatch(/extension_dev/);
  });
});
