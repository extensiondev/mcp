import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

const cliCalls: string[][] = [];
let cliResultOverride: { code: number; stdout: string; stderr: string } | null =
  null;
let onCli: ((args: string[]) => void) | null = null;
let whileCliRuns: ((args: string[]) => Promise<void>) | null = null;
const installCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
let installResult: { code: number | null; timedOut: boolean; leftRunningPid?: number; output: string } | null = null;
let skipDist = false;
let spawnRefusal: NodeJS.ErrnoException | null = null;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: (...call: Parameters<typeof actual.spawnExtensionCli>) => {
      if (spawnRefusal) throw spawnRefusal;

      return actual.spawnExtensionCli(...call);
    },
    runPackageInstall: async (command: string, args: string[], options: { cwd: string }) => {
      installCalls.push({ command, args, cwd: options.cwd });
      if (installResult) return installResult;

      fs.mkdirSync(path.join(options.cwd, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, "node_modules", ".bin", process.platform === "win32" ? "extension.cmd" : "extension"), "");

      return { code: 0, timedOut: false, output: "added 1 package" };
    },
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      onCli?.(args);
      await whileCliRuns?.(args);
      const browser = browserFromCliArgs(args);
      const answer = cliResultOverride ?? buildCliAnswer(args[1]!, browser);
      if (answer.code === 0 && !skipDist) writeEngineDist(args[1]!, browser);

      return answer;
    },
  };
});

const build = await import("../tools/build");
const dev = await import("../tools/dev");
const start = await import("../tools/start");
const { buildSummaryPath } = await import("../lib/session-paths");
const { installRecordPath, installStoppedPath, isInstallCommand, runningInstall, takeInstallTurn } = await import("../lib/project-install");
const { processStartedAt } = await import("../lib/process-identity");
const { buildCliAnswer, buildSummary, zipArtifacts, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];

function project(manifest: Record<string, unknown>, files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-gate-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  for (const file of files) {
    const full = path.join(dir, "src", file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "// present");
  }

  return dir;
}

const SOURCE_HOOKS = `
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const ours = (url) => typeof url === "string" && url.startsWith("file:") && !url.includes("/node_modules/");

registerHooks({
  resolve(specifier, context, next) {
    const bare = /^\\.\\.?\\//.test(specifier) && !/\\.(ts|mjs|js|json)$/.test(specifier);

    return next(bare && ours(context.parentURL) ? specifier + ".ts" : specifier, context);
  },
  load(url, context, next) {
    if (!ours(url) || !url.endsWith(".json")) return next(url, context);

    const text = fs.readFileSync(fileURLToPath(url), "utf8");

    return { format: "module", shortCircuit: true, source: "const json = " + text + "; export default json; export const dependencies = json.dependencies;" };
  },
});
`;
const INSTALL_SOURCE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "project-install.ts")).href;

function serverProcess(body: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-process-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "hooks.mjs"), SOURCE_HOOKS);
  fs.writeFileSync(path.join(dir, "main.mjs"), `const install = await import(${JSON.stringify(INSTALL_SOURCE)});\n${body}\n`);

  return spawn(process.execPath, ["--import", pathToFileURL(path.join(dir, "hooks.mjs")).href, path.join(dir, "main.mjs"), ...args], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  cliCalls.length = 0;
  cliResultOverride = null;
  onCli = null;
  whileCliRuns = null;
  installCalls.length = 0;
  installResult = null;
  skipDist = false;
  spawnRefusal = null;

  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_build says when the engine installed the project's dependencies first", () => {
  const withPackageJson = (): string => {
    const dir = project({ manifest_version: 3, name: "Deps", version: "1.0.0" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "deps", devDependencies: { extension: "latest" } }));

    return dir;
  };

  it("answers dependenciesInstalled and says so in the hint when node_modules appeared during the build", async () => {
    const dir = withPackageJson();

    onCli = () => fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(result.value.dependenciesInstalled).toBe(true);
    expect(result.hint).toContain(`The engine installed the project's dependencies first (${dir} had no node_modules)`);
    expect(result.hint).toContain("the next build skips that");
  });

  it("says nothing when node_modules was already there, or when none was written", async () => {
    const installed = withPackageJson();
    fs.mkdirSync(path.join(installed, "node_modules"));

    const warm = JSON.parse(await build.handler({ projectPath: installed }));

    expect(warm.value.dependenciesInstalled).toBeUndefined();
    expect(warm.hint).not.toContain("installed the project's dependencies");

    const bare = JSON.parse(await build.handler({ projectPath: project({ manifest_version: 3, name: "Bare", version: "1.0.0" }) }));

    expect(bare.value.dependenciesInstalled).toBeUndefined();
  });
});

describe("extension_build validation gate", () => {
  it("refuses to build a manifest with build-blocking errors", async () => {
    const dir = project({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("manifest-blocked");
    expect(result.value.errors.join(" ")).toContain("name");
    expect(result.hint).toContain("skipValidation");
    expect(cliCalls).toHaveLength(0);
  });

  it("builds anyway under skipValidation, as an explicit escape hatch", async () => {
    const dir = project({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.ok).toBe(true);
    expect(cliCalls).toHaveLength(1);
  });

  it("builds a valid manifest and runs the CLI", async () => {
    const dir = project(
      {
        manifest_version: 3,
        name: "Fixture",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
      },
      ["popup.html"],
    );

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toContain("build");
  });

  it("refuses to call a build successful when a declared entrypoint is missing from dist", async () => {
    const dir = project(
      {
        manifest_version: 3,
        name: "Fixture",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
      },
      ["popup.html"],
    );
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "manifest.json"),
      JSON.stringify({ action: { default_popup: "popup.html" } }),
    );

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("entrypoint-missing");
    expect(result.error.code).toBe("E_ENTRYPOINT_MISSING");
    expect(result.value.buildExitCode).toBe(0);
    expect(result.error.message).toContain("popup.html");
    expect(result.error.message).toContain("refuse to load");
  });

  it("reports success when every declared entrypoint is present in dist", async () => {
    const dir = project(
      {
        manifest_version: 3,
        name: "Fixture",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
      },
      ["popup.html"],
    );
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "manifest.json"),
      JSON.stringify({ action: { default_popup: "popup.html" } }),
    );

    fs.writeFileSync(path.join(distDir, "popup.html"), "<html></html>");

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
  });

  it("blocks on a dangling path reference instead of warning about it", async () => {
    const dir = project({
      manifest_version: 3,
      name: "Fixture",
      version: "1.0.0",
      action: { default_popup: "nope.html" },
    });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("manifest-blocked");
    expect(result.value.errors.join(" ")).toContain("nope.html");
    expect(cliCalls).toHaveLength(0);
  });

  it("still carries genuinely non-blocking warnings out of a green build", async () => {
    const dir = project(
      {
        manifest_version: 3,
        name: "Fixture",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
      },
      ["popup.html"],
    );

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.value.reviewRisks.map((risk: { code: string }) => risk.code)).toContain("ICON_128_MISSING");
    expect(result.warnings.join(" ")).toContain("ICON_128_MISSING");
  });
});

describe("extension_build zip path reporting", () => {
  function builtProject(name: string): string {
    const dir = project({ manifest_version: 3, name, version: "1.0.0" });
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name, version: "1.0.0" }),
    );

    return dir;
  }

  function engineWrites(dir: string, files: string[], summary?: Record<string, unknown>) {
    onCli = () => {
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "PK");
      }

      if (summary) {
        const file = buildSummaryPath(dir, "chrome");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(summary));
      }
    };
  }

  it("returns the path the engine's summary names", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "zipprobeext-1.0.0-chrome.zip");
    engineWrites(dir, [zip], buildSummary("chrome", { output_path: path.join(dir, "dist", "chrome"), zip_artifacts: zipArtifacts("zipprobeext", "1.0.0", "chrome").map((a) => ({ ...a, path: zip })) }));

    const result = JSON.parse(await build.handler({ projectPath: dir, zip: true }));

    expect(result.ok).toBe(true);
    expect(result.value.zipPath).toBe(zip);
    expect(result.warnings.join(" ")).not.toContain("names no zip");
  });

  it("says a build has no STORE.md beside it and where its format is, zipped or not, and says nothing once the file is there", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "zipprobeext-1.0.0-chrome.zip");
    engineWrites(dir, [zip]);

    for (const args of [{ zip: true }, {}]) {
      const missing = JSON.parse(await build.handler({ projectPath: dir, ...args }));
      const said = missing.warnings.filter((w: string) => w.includes("STORE.md"));

      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`No STORE.md is in ${dir}`);
      expect(said[0]).toContain('extension_docs_search "STORE.md" has the rest');
      expect(said[0]).toContain("Leave only its data-use and privacy rows unanswered");
      expect(missing.hint).not.toContain("STORE.md");
    }

    fs.writeFileSync(path.join(dir, "STORE.md"), "# Store metadata\n");

    const present = JSON.parse(await build.handler({ projectPath: dir, zip: true }));

    expect(`${present.hint} ${present.warnings.join(" ")}`).not.toContain("No STORE.md");
  });

  it("finds the engine's name at the dist root when the summary carries no list", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "zipprobeext-1.0.0-chrome.zip");
    engineWrites(dir, [zip]);

    const result = JSON.parse(await build.handler({ projectPath: dir, zip: true }));

    expect(result.value.zipPath).toBe(zip);
  });

  it("keeps a custom zipFilename's stem and case and adds the browser suffix, as the engine does", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "My Custom-Name v2-chrome.zip");
    engineWrites(dir, [zip]);

    const result = JSON.parse(
      await build.handler({ projectPath: dir, zip: true, zipFilename: "My Custom-Name v2" }),
    );

    expect(result.value.zipPath).toBe(zip);
  });

  it("falls back to the freshest archive for this browser when the name cannot be predicted", async () => {
    const dir = builtProject("__MSG_appName__");
    const zip = path.join(dir, "dist", "meine-erweiterung-1.0.0-chrome.zip");
    engineWrites(dir, [zip]);

    const result = JSON.parse(await build.handler({ projectPath: dir, zip: true }));

    expect(result.value.zipPath).toBe(zip);
  });

  it("never reports an archive from an earlier build", async () => {
    const dir = builtProject("zip-probe-ext");
    const old = path.join(dir, "dist", "zipprobeext-1.0.0-chrome.zip");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "PK");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);

    const result = JSON.parse(await build.handler({ projectPath: dir, zip: true }));

    expect(result.value.zipPath).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("no .zip newer than this build");
  });

  it("reports the source zip the engine wrote under its explicit name, not an older default-named one", async () => {
    const dir = builtProject("zip-probe-ext");
    const stale = path.join(dir, "dist", "zipprobeext-1.0.0-source.zip");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "PK");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, past, past);
    const fresh = path.join(dir, "dist", "release-source.zip");
    engineWrites(dir, [fresh]);

    const result = JSON.parse(
      await build.handler({ projectPath: dir, zipSource: true, zipFilename: "release" }),
    );

    expect(result.value.zipSourcePath).toBe(fresh);
  });

  it("says so explicitly when no zip can be located", async () => {
    const dir = builtProject("zip-probe-ext");

    const result = JSON.parse(await build.handler({ projectPath: dir, zip: true }));

    expect(result.ok).toBe(true);
    expect(result.value.zipPath).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("names no zip");
    expect(result.warnings.join(" ")).not.toContain("may not have packaged");
  });

  it("adds neither field on a build without zip", async () => {
    const dir = builtProject("zip-probe-ext");

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.value.zipPath).toBeUndefined();
    expect(result.value.zipSourcePath).toBeUndefined();
    expect(result.warnings.join(" ")).not.toContain("zip");
  });
});

describe("402: extension_build never writes over a live dev session's dist", () => {
  function writeReadyContract(dir: string, browser: string, pid: number): void {
    const contractDir = path.join(dir, "dist", "extension-js", browser);
    fs.mkdirSync(contractDir, { recursive: true });
    fs.writeFileSync(
      path.join(contractDir, "ready.json"),
      JSON.stringify({ status: "ready", pid }),
    );
  }

  it("refuses before the engine runs when a live session serves dist/<browser>, and names outDir", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "chrome", process.pid);

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-refused");
    expect(result.error.code).toBe("E_DEV_SESSION_DIST_SHARED");
    expect(result.error.message).toContain(`pid ${process.pid}`);
    expect(result.error.message).toContain("dist/chrome");
    expect(result.error.message).toContain("nothing was built");
    expect(result.value.livePids).toEqual([process.pid]);
    expect(result.hint).toContain("outDir");
    expect(result.hint).toContain("build/chrome");
    expect(result.hint).toContain("extension_stop");
    expect(cliCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "dist", "chrome", "manifest.json"))).toBe(false);
  });

  it("builds beside the session with outDir, passes --out-dir and reads <outDir>/<browser>", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "chrome", process.pid);
    const built = path.join(dir, "build", "chrome");
    skipDist = true;

    onCli = () => {
      fs.mkdirSync(built, { recursive: true });
      fs.writeFileSync(path.join(built, "manifest.json"), fs.readFileSync(path.join(dir, "src", "manifest.json")));
    };

    cliResultOverride = {
      code: 0,
      stdout: `${JSON.stringify({
        schema: 1,
        ok: true,
        command: "build",
        status: "built",
        value: { projectPath: dir, browsers: ["chrome"], mode: "production", summaries: [buildSummary("chrome", { output_path: built })] },
        error: null,
        warnings: [],
      })}\n`,
      stderr: "",
    };

    const result = JSON.parse(await build.handler({ projectPath: dir, outDir: "build" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("built");
    expect(result.value.outputPath).toBe(built);
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toContain("--out-dir");
    expect(cliCalls[0][cliCalls[0].indexOf("--out-dir") + 1]).toBe(path.join(dir, "build"));
    expect(result.warnings.join(" ")).not.toMatch(/wrote over|dev session/);
    expect(fs.existsSync(path.join(dir, "dist", "chrome", "manifest.json"))).toBe(false);
  });

  it("refuses outDir that names the project root", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir, outDir: "." }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.message).toContain("project root");
    expect(cliCalls).toHaveLength(0);
  });

  it("stays quiet when the ready contract's pid is dead", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "chrome", 999999);

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).not.toContain("dev session");
  });

  it("stays quiet when the live session holds a different browser's dist", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "firefox", process.pid);

    const result = JSON.parse(
      await build.handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).not.toContain("dev session");
  });

  it("names outDir when the engine itself refuses the shared dist", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    cliResultOverride = {
      code: 1,
      stdout: `${JSON.stringify({ schema: 1, ok: false, command: "build", status: "failed", value: null, error: { code: "E_DEV_SESSION_DIST_SHARED", message: "A running dev session serves dist/chrome." }, warnings: [] })}\n`,
      stderr: "",
    };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-refused");
    expect(result.error.code).toBe("E_DEV_SESSION_DIST_SHARED");
    expect(result.hint).toContain("outDir");
    expect(result.hint).toContain("extension_stop");
  });
});

describe("extension_build believes the disk, not the exit code", () => {
  it("refuses to call a build successful when the bundler exited 0 and wrote nothing", async () => {
    skipDist = true;
    const dir = project({ manifest_version: 3, name: "Fixture", version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-not-found");
    expect(result.error.code).toBe("E_BUILD_NOT_FOUND");
    expect(result.error.message).toContain("no manifest.json exists");
  });

  it("refuses a dist left by an earlier build", async () => {
    skipDist = true;
    const dir = project({ manifest_version: 3, name: "Fixture", version: "1.0.0" });
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "manifest.json"), "{}");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(distDir, "manifest.json"), past, past);

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.status).toBe("build-not-found");
    expect(result.error.message).toContain("predates this build");
  });

  it("reads the dist at the package root when the manifest sits in a subfolder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-root-"));
    tmpDirs.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "mono", devDependencies: { extension: "4.1.31" } }),
    );

    const sub = path.join(root, "Extensions", "combined");
    fs.mkdirSync(path.join(sub, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sub, "src", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Sub", version: "1.0.0" }),
    );

    onCli = () => {
      const dist = path.join(root, "dist", "chrome");
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Sub", version: "1.0.0" }));
    };

    skipDist = true;

    const result = JSON.parse(await build.handler({ projectPath: sub }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("built");
  });
});

describe("extension_build says when its manifest gate could not run", () => {
  it("warns instead of going quiet when the validator throws on a manifest shape", async () => {
    const dir = project({
      manifest_version: 3,
      name: "Fixture",
      version: "1.0.0",
      permissions: { storage: true },
    });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("Manifest validation did not run");
  });

  it("warns when the manifest cannot be parsed and the engine builds anyway", async () => {
    const dir = project({ manifest_version: 3, name: "Fixture", version: "1.0.0" });
    fs.writeFileSync(path.join(dir, "src", "manifest.json"), "\ufeff{ \"manifest_version\": 3, \"name\": \"Fixture\", \"version\": \"1.0.0\" }");

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.warnings.join(" ")).toContain("Manifest validation did not run");
  });
});

describe("extension_build names a run this server stopped", () => {
  it("answers build-timeout, not a compile failure, when the kill timer fired", async () => {
    const dir = project({ manifest_version: 3, name: "Fixture", version: "1.0.0" });
    cliResultOverride = { code: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" } as never;

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("build-timeout");
    expect(result.error.code).toBe("E_BUILD_TIMEOUT");
    expect(result.error.message).toContain("stopped the build after 180000 ms");
    expect(result.error.message).not.toContain("exited with code null");
  });
});

describe("941: one dependency install runs on a project at a time, and a build says when it waits on one", () => {
  const victims: ChildProcess[] = [];
  const INSTALL_HINT =
    "Call extension_build again with the same arguments: it waits for this install to end, then builds. Do not start an install by hand and do not poll the process table; the next call does the waiting.";

  function coldProject(): string {
    const dir = project({ manifest_version: 3, name: "Cold", version: "1.0.0" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cold", devDependencies: { extension: "latest" } }));

    return dir;
  }

  function installerStandIn(): number {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    victims.push(child);

    return child.pid!;
  }

  function end(pid: number): Promise<void> {
    const child = victims.find((victim) => victim.pid === pid)!;

    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }

  function holdInstall(dir: string, pid: number, startedAt: string | null = processStartedAt(pid)): void {
    const record = installRecordPath(dir);
    fs.mkdirSync(record, { recursive: true });
    fs.writeFileSync(path.join(record, "held.json"), JSON.stringify({ projectRoot: dir, since: new Date().toISOString(), holders: [{ pid, startedAt, role: "engine" }] }));
  }

  function recordText(dir: string): string {
    try {
      return fs.readdirSync(installRecordPath(dir)).map((name) => fs.readFileSync(path.join(installRecordPath(dir), name), "utf8")).join("\n");
    } catch {
      return "";
    }
  }

  afterEach(() => {
    vi.useRealTimers();

    for (const victim of victims.splice(0)) victim.kill("SIGKILL");
  });

  it("runs two first builds sent together one after the other, and the second says what it waited for", async () => {
    const dir = coldProject();
    let running = 0;
    let most = 0;

    whileCliRuns = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
      running -= 1;
    };

    const answers = (
      await Promise.all([build.handler({ projectPath: dir, browser: "firefox" }), build.handler({ projectPath: dir, browser: "chrome" })])
    ).map((text) => JSON.parse(text));
    const first = answers.find((answer) => answer.value.dependenciesInstalled === true);
    const second = answers.find((answer) => answer !== first);

    expect(most).toBe(1);
    expect(answers.map((answer) => answer.status)).toEqual(["built", "built"]);
    expect(second.value.dependenciesInstalled).toBeUndefined();
    expect(second.warnings.join(" ")).toMatch(
      new RegExp(`^This call waited [0-9.]+ s for another extension_build call on this project \\(server pid ${process.pid}\\) to finish installing this project's dependencies before it built; one install runs on a project at a time\\.`),
    );

    expect(first.warnings.join(" ")).not.toContain("This call waited");
    expect(fs.existsSync(installRecordPath(dir))).toBe(false);
  }, 20_000);

  it("answers E_BUILD_TIMEOUT with retry safe, and runs no engine, when the install outlasts its wait", async () => {
    const dir = coldProject();
    const pid = installerStandIn();
    fs.mkdirSync(path.join(dir, "node_modules", "extension"), { recursive: true });
    holdInstall(dir, pid);
    cliResultOverride = { code: 127, stdout: "", stderr: "sh: 1: extension: not found" };
    vi.useFakeTimers({ toFake: ["Date"] });

    const clock = setInterval(() => vi.setSystemTime(Date.now() + 136_000), 100);
    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }).finally(() => clearInterval(clock)));

    expect(cliCalls).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: "build-timeout", hint: INSTALL_HINT });
    expect(result.error).toMatchObject({ code: "E_BUILD_TIMEOUT", name: "BuildTimeout", retry: "safe" });
    expect(result.error.message).toMatch(
      new RegExp(`^Nothing was built: the engine an earlier extension_build call left running \\(pid ${pid}\\) is still installing this project's dependencies, and this call waited [0-9.]+ s for it to end\\.$`),
    );

    expect(result.value).toMatchObject({ browser: "chrome", buildExitCode: null, waitingOn: "dependency-install", installPid: pid });
    expect(result.value.waitedMs).toBeGreaterThanOrEqual(135_000);
  }, 20_000);

  it("builds once the install it waited on has ended, and clears a record nobody holds", async () => {
    const dir = coldProject();
    const pid = installerStandIn();
    fs.mkdirSync(path.join(dir, "node_modules", "extension"), { recursive: true });
    holdInstall(dir, pid);

    expect(runningInstall(dir)).toEqual({ pid, owner: "build-engine" });
    expect(takeInstallTurn(dir)).toBe("taken");

    const pending = build.handler({ projectPath: dir, browser: "chrome" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(cliCalls).toEqual([]);

    await end(pid);

    const result = JSON.parse(await pending);

    expect(result.status).toBe("built");
    expect(cliCalls.filter((call) => call[0] === "build")).toHaveLength(1);
    expect(installCalls).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain(`for the engine an earlier extension_build call left running (pid ${pid}) to finish installing`);
    expect(fs.existsSync(installRecordPath(dir))).toBe(false);
  }, 20_000);

  it("says the install was left running when the budget ends inside it, and hands the record to that engine", async () => {
    const dir = coldProject();
    const pid = installerStandIn();
    cliResultOverride = { code: null, signal: null, timedOut: true, leftRunningPid: pid, stdout: "Installing the project dependencies with npm", stderr: "" } as never;

    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));

    expect(result).toMatchObject({ ok: false, status: "build-timeout", hint: INSTALL_HINT });
    expect(result.error).toMatchObject({ code: "E_BUILD_TIMEOUT", retry: "safe" });
    expect(result.error.message).toBe(
      `The build did not finish in 180000 ms because the engine is still installing the project's dependencies (pid ${pid}). Nothing was stopped: the install keeps running, and the firefox build follows it in the same process.`,
    );

    expect(result.value).toMatchObject({ browser: "firefox", buildExitCode: null, budgetMs: 180000, waitingOn: "dependency-install", installPid: pid });
    expect(runningInstall(dir)).toEqual({ pid, owner: "build-engine" });

    await end(pid);

    expect(runningInstall(dir)).toBeNull();
  }, 20_000);

  it.each([
    { tool: "extension_dev", call: (projectPath: string) => dev.handler({ projectPath, browser: "chrome", noBrowser: true }) },
    { tool: "extension_start", call: (projectPath: string) => start.handler({ projectPath, browser: "chrome", noBrowser: true }) },
  ])("gives the install turn back when the operating system refuses to spawn the engine for $tool", async ({ call }) => {
    const dir = coldProject();
    spawnRefusal = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });

    await expect(call(dir)).rejects.toThrow("spawn E2BIG");

    vi.useFakeTimers({ toFake: ["Date"] });

    const clock = setInterval(() => vi.setSystemTime(Date.now() + 31_000), 100);
    const next = await call(dir).catch((err: Error) => err.message).finally(() => clearInterval(clock));

    expect(next).toBe("spawn E2BIG");
    expect(runningInstall(dir)).toBeNull();
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "waits for the install a killed server left running instead of starting a second one in the same folder",
    async () => {
      const dir = coldProject();
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slow-npm-"));
      const log = path.join(bin, "runs.log");
      tmpDirs.push(bin);
      fs.mkdirSync(path.join(dir, "node_modules", "extension"), { recursive: true });
      fs.writeFileSync(
        path.join(bin, "npm"),
        `#!/bin/sh\necho "start $$" >> "${log}"\nsleep 1.3\nmkdir -p node_modules/.bin\n: > node_modules/.bin/extension\necho end >> "${log}"\n`,
        { mode: 0o755 },
      );

      const runs = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
      const first = serverProcess("await install.settleInstall(process.argv[2], { waitMs: 20000, repairMs: 30000 });", [dir], {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      });
      victims.push(first);

      await vi.waitFor(() => expect(runs()).toHaveLength(1), { timeout: 10_000, interval: 50 });

      const installer = Number(runs()[0].split(" ")[1]);

      await vi.waitFor(() => expect(recordText(dir)).toContain(`"pid":${installer}`), { timeout: 5_000, interval: 20 });
      await end(first.pid!);

      const result = JSON.parse(await build.handler({ projectPath: dir }));

      expect(installCalls).toEqual([]);
      expect(runs()).toEqual([`start ${installer}`, "end"]);
      expect(result.status).toBe("built");
      expect(result.warnings.join(" ")).toContain(`for the install an earlier call left running (pid ${installer}) to finish installing`);
      expect(runningInstall(dir)).toBeNull();
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "gives a stale record to one server only when four take it over in the same instant",
    async () => {
      const dir = coldProject();
      const NOBODY = 2_147_483_000;
      const TAKER = `
        let turn = null;
        const say = (word) => process.stdout.write(word + "\\n");

        for await (const line of (await import("node:readline")).createInterface({ input: process.stdin })) {
          const [verb, at] = line.split(" ");

          if (verb === "take") {
            while (Date.now() < Number(at)) {}

            const taken = install.takeInstallTurn(process.argv[2]);
            turn = typeof taken === "string" ? null : taken;
            say(turn ? "held" : taken);
          } else {
            turn?.release();
            turn = null;
            say("released");
          }
        }
      `;
      const servers = [0, 1, 2, 3].map(() => {
        const child = serverProcess(TAKER, [dir]);
        victims.push(child);
        child.stdin!.on("error", () => undefined);

        return { child, lines: readline.createInterface({ input: child.stdout! })[Symbol.asyncIterator]() };
      });

      const all = async (line: string): Promise<string[]> => {
        for (const server of servers) server.child.stdin!.write(`${line}\n`);

        return Promise.all(servers.map(async (server) => String((await server.lines.next()).value)));
      };

      const until = Date.now() + 1_500;
      const holdersPerRound = new Set<number>();

      await all("release");

      for (let round = 0; round < 250 && Date.now() < until; round += 1) {
        holdInstall(dir, NOBODY, null);
        holdersPerRound.add((await all(`take ${Date.now() + 3}`)).filter((answer) => answer === "held").length);
        await all("release");
      }

      expect([...holdersPerRound]).toEqual([1]);
    },
    20_000,
  );

  it.skipIf(!fs.existsSync(os.tmpdir().toUpperCase()))("keeps one record for a folder reached by two spellings on a disk that ignores case", () => {
    const dir = coldProject();
    const shouted = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
    const turn = takeInstallTurn(dir);

    try {
      expect(fs.statSync(shouted).ino).toBe(fs.statSync(dir).ino);
      expect(takeInstallTurn(shouted)).toBe("taken");
      expect(runningInstall(shouted)).toEqual({ pid: process.pid, owner: "build-call" });
    } finally {
      if (typeof turn !== "string") turn.release();
    }

    expect(runningInstall(shouted)).toBeNull();
  });

  it("reads an install from the command line a package manager runs under, not from a path that holds its name", () => {
    expect(isInstallCommand("npm install --ignore-scripts")).toBe(true);
    expect(isInstallCommand("node /usr/lib/node_modules/npm/bin/npm-cli.js install --no-audit")).toBe(true);
    expect(isInstallCommand("node /opt/pnpm/bin/pnpm.cjs install")).toBe(true);
    expect(isInstallCommand("bun install")).toBe(true);
    expect(isInstallCommand("npm exec extension@4.1.41 build /work --browser chrome")).toBe(false);
    expect(isInstallCommand("node /home/me/.npm/_npx/1a2b/node_modules/.bin/extension build /work/install --browser chrome")).toBe(false);
  });
});

describe("948: a folder an install left incomplete is repaired under the record, never answered as a compile error", () => {
  const AGAIN = "Call extension_build again with the same arguments: it reinstalls the dependencies first, then builds.";

  function halfInstalled(lockfile?: string): string {
    const dir = project({ manifest_version: 3, name: "Half", version: "1.0.0" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "half", devDependencies: { extension: "latest" } }));
    fs.mkdirSync(path.join(dir, "node_modules", "extension"), { recursive: true });
    if (lockfile) fs.writeFileSync(path.join(dir, lockfile), "");

    return dir;
  }

  it("reruns the install when the extension package has no binary linked, then builds and says so", async () => {
    const dir = halfInstalled();

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toEqual([{ command: "npm", args: ["install", "--ignore-scripts"], cwd: dir }]);
    expect(result.status).toBe("built");
    const note = result.warnings.find((line: string) => line.includes("was left incomplete")) as string;

    expect(note.replace(/\([0-9.]+ m?s\)/, "(T)")).toBe(
      `node_modules under ${dir} was left incomplete by an install that did not finish (the extension package was there with no binary linked, or this server had stopped an engine in the middle of installing), so this call ran npm install --ignore-scripts there first (T) before building.`,
    );

    expect(fs.existsSync(installRecordPath(dir))).toBe(false);

    await build.handler({ projectPath: dir });

    expect(installCalls).toHaveLength(1);
  });

  it("answers install-incomplete with retry safe and the package manager's output when the repair fails", async () => {
    const dir = halfInstalled();
    installResult = { code: 1, timedOut: false, output: "npm error network request failed" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(cliCalls).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: "install-incomplete" });
    expect(result.error).toMatchObject({ code: "E_BUILD_FAILED", name: "InstallIncomplete", retry: "safe" });
    expect(result.error.message).toBe(
      `Nothing was built: node_modules under ${dir} is incomplete (an install did not finish), and npm install --ignore-scripts, which this call ran there to repair it, did not complete it.`,
    );

    expect(result.hint).toBe(
      "Read value.output for the package manager's own report and fix what it names (the network, the registry or a dependency version), then call extension_build again: it reruns the install first. This is not a compile error.",
    );

    expect(result.value).toMatchObject({ installRoot: dir, installCommand: "npm install --ignore-scripts", output: "npm error network request failed" });
  });

  it("names the install to run when the lockfile belongs to a package manager this server does not rerun", async () => {
    const dir = halfInstalled("yarn.lock");

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toEqual([]);
    expect(result.status).toBe("install-incomplete");
    expect(result.error.retry).toBe("safe");
    expect(result.error.message).toBe(
      `Nothing was built: node_modules under ${dir} is incomplete (an install did not finish), and this server does not rerun this project's package manager itself.`,
    );

    expect(result.hint).toBe(`Run the project's own install in ${dir} (yarn install or deno install, by the lockfile there), then call extension_build again. This is not a compile error.`);
  });

  it("reads the engine binary not found as an incomplete install, and the next call reinstalls", async () => {
    const dir = project({ manifest_version: 3, name: "Stray", version: "1.0.0" });
    fs.mkdirSync(path.join(dir, "node_modules"));
    cliResultOverride = { code: 127, stdout: "", stderr: "sh: 1: extension: not found" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result).toMatchObject({ ok: false, status: "install-incomplete", hint: AGAIN });
    expect(result.error).toMatchObject({ code: "E_BUILD_FAILED", retry: "safe" });
    expect(result.error.message).toBe(
      `Nothing was built: the engine binary was not found although ${dir} has a node_modules, which is an install that did not finish, not a compile error.`,
    );

    expect(result.hint).not.toMatch(/compile error, a manifest/);

    cliResultOverride = null;

    const next = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toEqual([{ command: "npm", args: ["install", "--ignore-scripts"], cwd: dir }]);
    expect(next.status).toBe("built");
    expect(fs.existsSync(installStoppedPath(dir))).toBe(false);
  });

  it("says the install was stopped when the engine is stopped at its budget inside it, and the next call reinstalls", async () => {
    const dir = project({ manifest_version: 3, name: "Cut", version: "1.0.0" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cut", devDependencies: { extension: "latest" } }));
    cliResultOverride = { code: null, signal: "SIGTERM", timedOut: true, stdout: "Installing the project dependencies with npm", stderr: "" } as never;

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result).toMatchObject({ ok: false, status: "build-timeout", hint: AGAIN });
    expect(result.error).toMatchObject({ code: "E_BUILD_TIMEOUT", retry: "safe" });
    expect(result.error.message).toBe(
      "This server stopped the build after 180000 ms (SIGTERM) while the engine was installing the project's dependencies, so that install was stopped with it and node_modules may be incomplete.",
    );

    expect(result.value.installStopped).toBe(true);

    fs.mkdirSync(path.join(dir, "node_modules"));
    cliResultOverride = null;

    const next = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toHaveLength(1);
    expect(next.status).toBe("built");
  });
});
