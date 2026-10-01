import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type SpawnedCli = import("../lib/exec").SpawnedCli;

const spawned: ChildProcess[] = [];
const spawnedArgs: string[][] = [];
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
  const actual = await importOriginal<typeof import("../lib/exec")>();
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
    verdict: { kind: "started" },
    warnings: [],
    evidenceTail: "",
  }),
}));

const start = await import("../tools/start");
const { removeSession } = await import("../lib/process-manager");

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-output-"));
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
  for (const dir of tmpDirs.splice(0)) {
    try {
      removeSession(dir, "chrome");
    } catch {
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_start runs a prebuilt unpacked extension through the engine's preview verb", () => {
  it("passes an existing directory as --output-path and never builds", async () => {
    const project = tmpProject();
    const built = path.join(project, "build", "firefox");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "manifest.json"), JSON.stringify({ manifest_version: 2, name: "Z" }));

    const result = JSON.parse(
      await start.handler({ projectPath: project, browser: "firefox", outputPath: "build/firefox" }),
    );

    expect(result.ok).toBe(true);
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0][0]).toBe("preview");
    expect(spawnedArgs[0]).toContain("--output-path");
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--output-path") + 1]).toBe(built);
    expect(spawnedArgs[0]).not.toContain("--polyfill");
  });

  it("refuses a directory with no manifest before anything launches", async () => {
    const project = tmpProject();
    fs.mkdirSync(path.join(project, "empty"), { recursive: true });

    const result = JSON.parse(
      await start.handler({ projectPath: project, outputPath: "empty" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_NO_DIST");
    expect(result.error.message).toContain("manifest.json");
    expect(spawnedArgs).toEqual([]);
  });

  it("still builds and starts when no outputPath is given", async () => {
    const project = tmpProject();

    await start.handler({ projectPath: project });

    expect(spawnedArgs[0][0]).toBe("start");
    expect(spawnedArgs[0]).not.toContain("--output-path");
  });
});
