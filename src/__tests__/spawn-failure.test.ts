import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type { SpawnedCli } from "../lib/exec";


function failedSpawn(): SpawnedCli {
  const child = {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    on: () => child,
    unref: () => child,
  };

  return {
    child: child as unknown as ChildProcess,
    logPath: path.join(os.tmpdir(), "mcp-spawn-failure.log"),
    readOutput: () => "",
    spawnError: () => new Error("spawn npx ENOENT"),
  };
}

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => failedSpawn(),
  };
});

const dev = await import("../tools/dev");
const start = await import("../tools/start");
const { listSessions, listSessionMarkers } = await import(
  "../lib/process-manager"
);

const tmpDirs: string[] = [];

const inMemorySession = (projectPath: string, browser: string) =>
  listSessions().find(
    (s) => path.resolve(s.projectPath) === path.resolve(projectPath) && s.browser === browser,
  );

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-spawn-failure-"));
  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("spawn failure never registers a phantom session", () => {
  it("extension_dev fails the call with E_CLI and registers nothing", async () => {
    const project = tmpProject();

    const result = JSON.parse(await dev.handler({ wait: false, projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("spawn-failed");
    expect(result.error.code).toBe("E_CLI");
    expect(result.error.message).toContain("ENOENT");
    expect(result.error.message).toContain("nothing was registered");
    expect(result.hint).toContain("npm i -D extension");
    expect(inMemorySession(project, "chrome")).toBeUndefined();
    const markers = listSessionMarkers().map((m) => path.resolve(m.projectPath));
    expect(markers).not.toContain(path.resolve(project));
  });

  it("extension_start fails the same way", async () => {
    const project = tmpProject();

    const result = JSON.parse(await start.handler({ projectPath: project }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("spawn-failed");
    expect(result.error.code).toBe("E_CLI");
    expect(inMemorySession(project, "chrome")).toBeUndefined();
  });
});
