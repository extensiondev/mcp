import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import type * as ExecModule from "../lib/exec";
import type * as EngineVersionModule from "../lib/engine-version";
import type { SpawnedCli } from "../lib/exec";

const spawned: ChildProcess[] = [];
const spawnedArgs: string[][] = [];
const spawnedDirs: Array<string | undefined> = [];
const cliCalls: Array<{ args: string[]; cwd?: string }> = [];
let buildAnswer: (args: string[]) => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: "", stderr: "" });
let engineVersion: string | null = "4.1.38";

function fakeCli(): SpawnedCli {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: ["ignore", fd, fd] });
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
    spawnExtensionCli: (args: string[], options?: { projectDir?: string }) => {
      spawnedArgs.push(args);
      spawnedDirs.push(options?.projectDir);

      return fakeCli();
    },
    runExtensionCli: async (args: string[], options?: { cwd?: string }) => {
      cliCalls.push({ args, cwd: options?.cwd });

      return buildAnswer(args);
    },
  };
});

vi.mock("../lib/engine-version", async (importOriginal) => {
  const actual = await importOriginal<typeof EngineVersionModule>();

  return {
    ...actual,
    resolvedEngineFacts: async () => ({ version: engineVersion, outputJsonCommands: null }),
  };
});

vi.mock("../lib/boot-verdict", () => ({
  pollBootVerdict: async () => ({ verdict: { kind: "started" }, warnings: [], evidenceTail: "" }),
}));

const start = await import("../tools/start");
const { removeSession } = await import("../lib/process-manager");
const { ISOLATED_ROOT_ENV, ISOLATED_MARKER, isolatedRoot } = await import("../lib/isolated-run");

const tmpDirs: string[] = [];
let isolatedRootDir = "";

function sourceProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-isolated-src-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Iso", version: "1.0.0" }));
  fs.mkdirSync(path.join(dir, "dist", "chrome"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "chrome", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Iso dev build", version: "1.0.0" }));

  return dir;
}

function buildWrites(): void {
  buildAnswer = (args) => {
    const outDir = args[args.indexOf("--out-dir") + 1]!;
    const built = path.join(outDir, "chrome");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Iso", version: "1.0.0" }));

    return { code: 0, stdout: "built", stderr: "" };
  };
}

beforeEach(() => {
  isolatedRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-isolated-root-"));
  process.env[ISOLATED_ROOT_ENV] = isolatedRootDir;
  engineVersion = "4.1.38";
  buildWrites();
});

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }

  spawnedArgs.length = 0;
  spawnedDirs.length = 0;
  cliCalls.length = 0;

  for (const run of fs.existsSync(isolatedRootDir) ? fs.readdirSync(isolatedRootDir) : []) {
    try {
      removeSession(path.join(isolatedRootDir, run), "chrome");
    } catch {
    }
  }

  delete process.env[ISOLATED_ROOT_ENV];
  fs.rmSync(isolatedRootDir, { recursive: true, force: true });

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("401: extension_start isolated runs a throwaway session beside the person's own", () => {
  it("builds the project into a temp folder with --out-dir, launches from there on its own profile, and names that folder as the projectPath for every other tool", async () => {
    const source = sourceProject();
    const devManifestBefore = fs.readFileSync(path.join(source, "dist", "chrome", "manifest.json"), "utf8");

    const result = JSON.parse(await start.handler({ wait: false, projectPath: source, browser: "chrome", isolated: true, allowEval: true }));

    expect(result.ok).toBe(true);
    const run = result.value.isolated;
    expect(typeof run.projectPath).toBe("string");
    expect(path.dirname(run.projectPath)).toBe(isolatedRoot());
    expect(run.sourceProject).toBe(path.resolve(source));
    expect(run.extensionDir).toBe(path.join(run.projectPath, "build", "chrome"));
    expect(run.profile).toBe(path.join(run.projectPath, "profile"));
    expect(fs.existsSync(path.join(run.projectPath, ISOLATED_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(run.projectPath, "package.json"))).toBe(true);

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].args.slice(0, 4)).toEqual(["build", source, "--browser", "chrome"]);
    expect(cliCalls[0].args[cliCalls[0].args.indexOf("--out-dir") + 1]).toBe(path.join(run.projectPath, "build"));
    expect(cliCalls[0].cwd).toBe(source);

    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0][0]).toBe("preview");
    expect(spawnedArgs[0][1]).toBe(run.projectPath);
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--output-path") + 1]).toBe(run.extensionDir);
    expect(spawnedArgs[0][spawnedArgs[0].indexOf("--profile") + 1]).toBe(run.profile);
    expect(spawnedArgs[0]).toContain("--allow-eval");
    expect(spawnedDirs[0]).toBe(run.projectPath);

    expect(result.value.projectPath).toBe(run.projectPath);
    expect(result.hint).toContain(`projectPath "${run.projectPath}"`);
    expect(result.hint).toContain("extension_stop");
    expect(result.hint).toContain("not touched");
    expect(fs.readFileSync(path.join(source, "dist", "chrome", "manifest.json"), "utf8")).toBe(devManifestBefore);
    expect(fs.existsSync(path.join(source, "build"))).toBe(false);
  });

  it("runs headless by default and headed only on headless: false", async () => {
    const source = sourceProject();

    const quiet = JSON.parse(await start.handler({ wait: false, projectPath: source, isolated: true }));
    const shown = JSON.parse(await start.handler({ wait: false, projectPath: source, isolated: true, headless: false }));

    expect(spawnedArgs).toHaveLength(2);
    expect(quiet.value.headless).toBe(true);
    expect(shown.value.headless).toBe(false);
  });

  it("refuses the arguments that cannot go with isolated before building anything", async () => {
    const source = sourceProject();

    const result = JSON.parse(await start.handler({ wait: false, projectPath: source, isolated: true, replace: true, outputPath: "dist/chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.message).toContain("replace");
    expect(result.error.message).toContain("outputPath");
    expect(cliCalls).toHaveLength(0);
    expect(spawnedArgs).toHaveLength(0);
  });

  it("refuses an engine older than 4.1.36 by name, since --out-dir is how the run stays beside the project", async () => {
    const source = sourceProject();
    engineVersion = "4.1.35";

    const result = JSON.parse(await start.handler({ wait: false, projectPath: source, isolated: true }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("engine-unsupported");
    expect(result.error.code).toBe("E_ENGINE_TOO_OLD");
    expect(result.error.message).toContain("4.1.35");
    expect(result.error.message).toContain("4.1.36");
    expect(cliCalls).toHaveLength(0);
    expect(fs.readdirSync(isolatedRootDir)).toEqual([]);
  });

  it("answers build-failed with the bundler's output and removes the run folder when the build fails", async () => {
    const source = sourceProject();
    buildAnswer = () => ({ code: 1, stdout: "", stderr: "Module not found: ./missing" });

    const result = JSON.parse(await start.handler({ wait: false, projectPath: source, isolated: true }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-failed");
    expect(result.error.code).toBe("E_BUILD_FAILED");
    expect(result.value.output).toContain("Module not found");
    expect(result.error.message).toContain("not touched");
    expect(spawnedArgs).toHaveLength(0);
    expect(fs.readdirSync(isolatedRootDir)).toEqual([]);
  });

  it("the schema says what isolated does and what to pass afterwards", () => {
    const isolated = (start.schema.inputSchema.properties as unknown as Record<string, { description: string }>).isolated;

    expect(isolated.description).toMatch(/value\.isolated\.projectPath/);
    expect(isolated.description).toMatch(/extension_stop/);
    expect(isolated.description).toMatch(/4\.1\.36/);
  });
});
