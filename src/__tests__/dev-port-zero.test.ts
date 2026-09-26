import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type SpawnedCli = import("../lib/exec").SpawnedCli;

const spawned: ChildProcess[] = [];
function fakeCli(script: string): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", script], {
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

let nextChild: () => SpawnedCli = () => fakeCli("setTimeout(()=>{}, 60000)");
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    spawnExtensionCli: () => nextChild(),
  };
});

const dev = await import("../tools/dev");
const { removeSession } = await import("../lib/process-manager");
const { writeModernContract } = await import("./fixtures/ready-contract");

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-port-zero-"));
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
  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  nextChild = () => fakeCli("setTimeout(()=>{}, 60000)");
});

describe("extension_dev with port 0 asks for any free port, which is never a collision", () => {
  it("says the engine picked the port instead of calling port 0 unavailable", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');
      setTimeout(() => {
        writeModernContract(project, "chrome", {
          command: "dev",
          port: 53753,
          pid: process.pid,
          runtime: "attached",
          executorAttachedAt: new Date().toISOString(),
        });
      }, 1000);
      return cli;
    };

    const result = JSON.parse(await dev.handler({ projectPath: project, port: 0 }));

    expect(result.ok).toBe(true);
    expect(result.value.port).toBe(53753);
    expect(result.value.requestedPort).toBe(0);
    const note = result.warnings.join(" ");
    expect(note).toContain("any free port");
    expect(note).toContain("53753");
    expect(note).not.toContain("was not available");
  }, 20_000);

  it("keeps the collision wording for a numbered port the server could not bind", async () => {
    const project = tmpProject();
    nextChild = () => {
      const cli = fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');
      setTimeout(() => {
        writeModernContract(project, "chrome", {
          command: "dev",
          port: 8081,
          pid: process.pid,
          runtime: "attached",
          executorAttachedAt: new Date().toISOString(),
        });
      }, 1000);
      return cli;
    };

    const result = JSON.parse(await dev.handler({ projectPath: project, port: 8080 }));

    expect(result.warnings.join(" ")).toContain("Requested port 8080 was not available");
  }, 20_000);

  it("explains a port 0 start whose contract has not landed without a collision", async () => {
    const project = tmpProject();
    nextChild = () =>
      fakeCli('console.log("ready in 300ms"); setTimeout(()=>{}, 60000);');

    const result = JSON.parse(await dev.handler({ projectPath: project, port: 0 }));

    expect(result.ok).toBe(true);
    expect(result.value.requestedPort).toBe(0);
    const note = result.warnings.join(" ");
    expect(note).toContain("any free port");
    expect(note).not.toContain("taken port");
  }, 15_000);
});
