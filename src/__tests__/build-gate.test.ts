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
let installResult: { code: number | null; timedOut: boolean; leftRunningPid?: number; notFound?: boolean; output: string } | null = null;
let installLinks: ((cwd: string) => string | null) | null = null;
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

      const linked = installLinks ? installLinks(options.cwd) : path.join(options.cwd, "node_modules", ".bin");

      if (linked) {
        fs.mkdirSync(linked, { recursive: true });
        fs.writeFileSync(path.join(linked, process.platform === "win32" ? "extension.cmd" : "extension"), "");
      }

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
const { installRecordPath, installStoppedPath, installerUnder, isInstallCommand, runningInstall, takeInstallTurn } = await import("../lib/project-install");
const { processStartedAt, procfs } = await import("../lib/process-identity");
const { descendantPids } = await import("../lib/exec");
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
  installLinks = null;
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
  it("refuses to build a manifest with build-blocking errors, and asks the validator for the store listing lines it leaves out by default", async () => {
    const dir = project({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("manifest-blocked");
    expect(result.value.errors.join(" ")).toContain("name");
    expect(result.hint).toContain("skipValidation");
    expect(result.warnings.join(" ")).toContain("No 128x128 icon declared");
    expect(cliCalls).toHaveLength(0);
  });

  it("822: refuses a Chromium-family build over a key the browser will not load and names the key paths, and builds the same manifest for Firefox", async () => {
    const manifest = {
      manifest_version: 3,
      name: "Refused",
      version: "1.0.0",
      options_ui: { page: "options.html", chrome_style: true },
      icons: { 16: "icon.png", any: "icon.png" },
      browser_specific_settings: { gecko: { id: "refused@example.com" } },
    };
    const dir = project(manifest, ["options.html", "icon.png"]);
    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "edge" }));

    expect(result).toMatchObject({ ok: false, status: "manifest-blocked", error: { code: "E_MANIFEST_BLOCKING" } });
    expect(result.value.refusedKeys).toEqual(["options_ui.chrome_style", "icons.any"]);
    expect(result.value.errors.join(" ")).toContain('edge: Microsoft Edge refuses to load this manifest, so nobody can install the extension: options_ui.chrome_style is set to true, and Chromium answers "The chrome_style option cannot be used with manifest version 3."');
    expect(cliCalls).toHaveLength(0);

    const firefox = JSON.parse(await build.handler({ projectPath: dir, browser: "firefox" }));

    expect(firefox.status).toBe("built");
    expect(firefox.value.refusedKeys).toBeUndefined();
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

  it("says a zipped build has no STORE.md beside it and where its format is, and says nothing for a plain build or once the file is there", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "zipprobeext-1.0.0-chrome.zip");
    engineWrites(dir, [zip]);

    const missing = JSON.parse(await build.handler({ projectPath: dir, zip: true }));
    const said = missing.warnings.filter((w: string) => w.includes("STORE.md"));

    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`No STORE.md is in ${dir}`);
    expect(said[0]).toContain('extension_docs_search "STORE.md" has the rest');
    expect(said[0]).toContain("Leave only its data-use and privacy rows unanswered");
    expect(missing.hint).not.toContain("STORE.md");

    const plain = JSON.parse(await build.handler({ projectPath: dir }));

    expect(`${plain.hint} ${plain.warnings.join(" ")}`).not.toContain("STORE.md");

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

  it.each([
    [
      "a node_modules that holds none of the packages the project declares",
      (): string => {
        const dir = coldProject();
        fs.mkdirSync(path.join(dir, "node_modules", ".cache"), { recursive: true });

        return dir;
      },
    ],
    [
      "a Deno project that imports npm packages",
      (): string => {
        const dir = project({ manifest_version: 3, name: "Deno", version: "1.0.0" });
        fs.writeFileSync(path.join(dir, "deno.jsonc"), '{\n  // the bundler needs this one\n  "imports": { "react": "npm:react@18", },\n}\n');

        return dir;
      },
    ],
  ])("takes the record wherever the engine would install: %s", async (_layout, make) => {
    const dir = make();
    let running = 0;
    let most = 0;

    whileCliRuns = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 300));

      for (const name of ["extension", "react", ".bin"]) fs.mkdirSync(path.join(dir, "node_modules", name), { recursive: true });

      fs.writeFileSync(path.join(dir, "node_modules", ".bin", "extension"), "");
      running -= 1;
    };

    const answers = (
      await Promise.all([build.handler({ projectPath: dir, browser: "firefox" }), build.handler({ projectPath: dir, browser: "chrome" })])
    ).map((text) => JSON.parse(text));

    expect(most).toBe(1);
    expect(answers.map((answer) => answer.status)).toEqual(["built", "built"]);
    expect(answers.filter((answer) => answer.warnings.join(" ").includes("This call waited"))).toHaveLength(1);
  }, 20_000);

  it("takes no record for a workspace member whose packages are hoisted to the workspace root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-workspace-"));
    const dir = path.join(root, "packages", "ext");
    let during: unknown = "never ran";

    tmpDirs.push(root);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "extension"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", ".bin"));
    fs.writeFileSync(path.join(root, "node_modules", ".bin", "extension"), "");
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ext", devDependencies: { extension: "latest" } }));
    fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Member", version: "1.0.0" }));

    onCli = () => {
      during = runningInstall(dir);
    };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.status).toBe("built");
    expect(during).toBeNull();
    expect(installCalls).toEqual([]);
  });

  it("answers installing as progress, with no error and no engine run, when the install outlasts its wait", async () => {
    const dir = coldProject();
    const pid = installerStandIn();
    fs.mkdirSync(path.join(dir, "node_modules", "extension"), { recursive: true });
    holdInstall(dir, pid);
    cliResultOverride = { code: 127, stdout: "", stderr: "sh: 1: extension: not found" };
    vi.useFakeTimers({ toFake: ["Date"] });

    const clock = setInterval(() => vi.setSystemTime(Date.now() + 136_000), 100);
    const result = JSON.parse(await build.handler({ projectPath: dir, browser: "chrome" }).finally(() => clearInterval(clock)));

    expect(cliCalls).toEqual([]);
    expect(result).toMatchObject({ ok: true, command: "extension_build", status: "installing", error: null });
    expect(result.value).toMatchObject({ browser: "chrome", built: false, waitingOn: "dependency-install", installPid: pid, retry: "safe" });
    expect(result.value.waitedMs).toBeGreaterThanOrEqual(135_000);
    expect(result.hint).toMatch(
      new RegExp(
        `^Nothing was built: the engine an earlier extension_build call left running \\(pid ${pid}\\) is still installing this project's dependencies, and this call waited [0-9.]+ s for it to end\\. ${INSTALL_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    );
  }, 20_000);

  it("1022 d: a holder keeps the record across a step of the wall clock, by its clock ticks since boot, and loses it when the ticks are another process's", () => {
    const dir = coldProject();
    const pid = installerStandIn();
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proc-ticks-"));
    const previousRoot = procfs.root;
    const stat = (ticks: number): void =>
      fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 900 0 0 0 12 3 0 0 20 0 11 0 ${ticks} 1 2 3`);

    tmpDirs.push(proc);
    fs.mkdirSync(path.join(proc, String(pid)));
    stat(360_000);
    procfs.root = proc;

    try {
      const turn = takeInstallTurn(dir);

      if (typeof turn === "string") throw new Error(`the install turn was ${turn}`);

      turn.handOver(pid);

      const file = path.join(installRecordPath(dir), fs.readdirSync(installRecordPath(dir))[0]);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));

      expect(record.holders).toMatchObject([{ pid, role: "engine", startTicks: 360_000 }]);

      const stepped = new Date(Date.parse(record.holders[0].startedAt ?? new Date().toISOString()) - 3_600_000).toISOString();

      const write = (holder: Record<string, unknown>): void => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ...record, holders: [holder] }));
      };

      write({ ...record.holders[0], startedAt: stepped });

      expect(runningInstall(dir)).toEqual({ pid, owner: "build-engine" });
      expect(takeInstallTurn(dir)).toBe("taken");

      write({ pid, startedAt: stepped, role: "engine" });

      expect(runningInstall(dir)).toBeNull();

      write({ ...record.holders[0], startedAt: stepped });
      stat(360_001);

      expect(runningInstall(dir)).toBeNull();
    } finally {
      procfs.root = previousRoot;
    }
  });

  it("1065: a holder's record takes the boot id with its ticks, and the same pid at the same ticks after a reboot does not hold it", () => {
    const dir = coldProject();
    const pid = installerStandIn();
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proc-boot-"));
    const previousRoot = procfs.root;
    const BOOT = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
    const boot = (id: string): void => fs.writeFileSync(path.join(proc, "sys", "kernel", "random", "boot_id"), `${id}\n`);

    tmpDirs.push(proc);
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.mkdirSync(path.join(proc, "sys", "kernel", "random"), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 900 0 0 0 12 3 0 0 20 0 11 0 360000 1 2 3`);
    boot(BOOT);
    procfs.root = proc;

    try {
      const turn = takeInstallTurn(dir);

      if (typeof turn === "string") throw new Error(`the install turn was ${turn}`);

      turn.handOver(pid);

      const file = path.join(installRecordPath(dir), fs.readdirSync(installRecordPath(dir))[0]);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));

      expect(record.holders).toMatchObject([{ pid, role: "engine", startTicks: 360_000, bootId: BOOT }]);
      expect(runningInstall(dir)).toEqual({ pid, owner: "build-engine" });

      boot("9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a");

      expect(runningInstall(dir)).toBeNull();
    } finally {
      procfs.root = previousRoot;
    }
  });

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

      expect(installerUnder(first.pid!)).toBe(installer);

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
    expect(isInstallCommand("/Users/Jo Smith/.nvm/versions/node/v24/bin/node /Users/Jo Smith/.nvm/versions/node/v24/lib/node_modules/pnpm/bin/pnpm.cjs install --ignore-scripts")).toBe(true);
    expect(isInstallCommand("node /home/me/.yarn/releases/yarn-4.5.0.cjs install")).toBe(true);
    expect(isInstallCommand("node /usr/local/bin/corepack pnpm install --ignore-scripts")).toBe(true);
    expect(isInstallCommand(["/opt/My Tools/node", "/work/npm install/extension.js", "build", "/work"])).toBe(false);
  });

  it.skipIf(process.platform === "win32")("finds the install under an engine from the kernel's process files where pgrep and ps are missing", () => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proc-"));
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-no-pgrep-"));
    const previous = { path: process.env.PATH, root: procfs.root };

    const entry = (pid: number, parent: number, name: string, argv: string[]): void => {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (${name}) S ${parent} ${pid} ${pid} 0 -1 4194304 900 0 0 0 12 3 0 0 20 0 11 0 360000 1 2 3`);
      fs.writeFileSync(path.join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
    };

    tmpDirs.push(proc, emptyBin);
    entry(100, 1, "node", ["node", "/work/node_modules/.bin/extension", "build", "/work"]);
    entry(101, 100, "sh", ["sh", "-c", "pnpm install"]);
    entry(102, 101, "node (pnpm)", ["/home/Jo Smith/bin/node", "/home/Jo Smith/lib/pnpm/bin/pnpm.cjs", "install", "--ignore-scripts"]);
    entry(200, 1, "npm", ["npm", "install"]);
    fs.mkdirSync(path.join(proc, "self"));
    process.env.PATH = emptyBin;
    procfs.root = proc;

    try {
      expect(descendantPids(100)).toEqual([101, 102]);
      expect(installerUnder(100)).toBe(102);
      expect(installerUnder(101)).toBe(102);
      expect(installerUnder(102)).toBeNull();
    } finally {
      process.env.PATH = previous.path;
      procfs.root = previous.root;
    }
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

    expect(result.hint).toBe(`Run yarn install in ${dir}, then call extension_build again. This is not a compile error.`);
  });

  function workspace(files: Record<string, string>): { root: string; member: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-workspace-"));
    const member = path.join(root, "packages", "ext");

    tmpDirs.push(root);
    fs.mkdirSync(path.join(member, "src"), { recursive: true });
    fs.mkdirSync(path.join(member, "node_modules", "extension"), { recursive: true });
    fs.writeFileSync(path.join(member, "package.json"), JSON.stringify({ name: "ext", devDependencies: { extension: "latest", lib: "workspace:*" } }));
    fs.writeFileSync(path.join(member, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Member", version: "1.0.0" }));

    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);

    return { root, member };
  }

  it.each([
    [
      "a pnpm workspace member from its workspace root, filtered to the member",
      (): { dir: string; call: object } => {
        const { root, member } = workspace({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "pnpm-lock.yaml": "" });

        return { dir: member, call: { command: "pnpm", args: ["install", "--ignore-scripts", "--filter", "{packages/ext}..."], cwd: root } };
      },
    ],
    [
      "an npm workspace member from its workspace root",
      (): { dir: string; call: object } => {
        const { root, member } = workspace({ "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }), "package-lock.json": "{}" });

        return { dir: member, call: { command: "npm", args: ["install", "--ignore-scripts"], cwd: root } };
      },
    ],
    [
      "a project that names pnpm in packageManager and has no lockfile yet, confined to the project",
      (): { dir: string; call: object } => {
        const dir = halfInstalled();
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "half", packageManager: "pnpm@10.19.0", devDependencies: { extension: "latest" } }));

        return { dir, call: { command: "pnpm", args: ["install", "--ignore-scripts", "--ignore-workspace"], cwd: dir } };
      },
    ],
  ])("repairs %s", async (_layout, make) => {
    const { dir, call } = make();
    installLinks = () => path.join(dir, "node_modules", ".bin");

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toEqual([call]);
    expect(result.status).toBe("built");
  });

  it("runs no npm inside a yarn workspace member, and names the install to run at the workspace root", async () => {
    const { root, member } = workspace({ "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }), "yarn.lock": "" });

    const result = JSON.parse(await build.handler({ projectPath: member }));

    expect(installCalls).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: "install-incomplete" });
    expect(result.value.installRoot).toBe(root);
    expect(result.hint).toBe(`Run yarn install in ${root}, then call extension_build again. This is not a compile error.`);
  });

  it.skipIf(process.platform === "win32")("names the install to run by hand when the project's package manager is not on the PATH", async () => {
    const dir = halfInstalled("pnpm-lock.yaml");
    const real = await vi.importActual<typeof ExecModule>("../lib/exec");

    installResult = await real.runPackageInstall("a-package-manager-nobody-installed", ["install"], { cwd: dir, timeoutMs: 5_000 });

    expect(installResult).toMatchObject({ code: 1, notFound: true });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.status).toBe("install-incomplete");
    expect(result.error.message).toBe(
      `Nothing was built: node_modules under ${dir} is incomplete (an install did not finish), and pnpm, which installs this project, is not on the PATH this server runs with.`,
    );

    expect(result.hint).toBe(`Run pnpm install in ${dir}, then call extension_build again. This is not a compile error.`);
  });

  it("answers once when a completed install still links no binary, then builds without repairing again", async () => {
    const dir = halfInstalled();
    installLinks = () => null;

    const first = JSON.parse(await build.handler({ projectPath: dir }));

    expect(first).toMatchObject({ ok: false, status: "install-incomplete" });
    expect(first.error.retry).toBe("safe");
    expect(first.error.message).toBe(
      `Nothing was built: npm install --ignore-scripts completed in ${dir} and still linked no extension binary under ${path.join(dir, "node_modules", ".bin")}.`,
    );

    expect(first.hint).toBe(
      "Call extension_build again with the same arguments: it does not rerun the install, and builds with this server's pinned engine instead of the project's own. A package manager set not to link binaries (bin-links=false in .npmrc) leaves node_modules this way.",
    );

    const second = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toHaveLength(1);
    expect(second.status).toBe("built");
  });

  it.each([
    ["extension.exe", 0],
    ["extension.CMD", 0],
    ["extension-create", 1],
  ])("reads a .bin entry named %s as %i repairs to run", async (entry, repairs) => {
    const dir = halfInstalled();
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"));
    fs.writeFileSync(path.join(dir, "node_modules", ".bin", entry), "");

    await build.handler({ projectPath: dir });

    expect(installCalls).toHaveLength(repairs);
  });

  it("never repairs a node_modules above the project's own repository", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-above-"));
    const dir = path.join(outside, "repo");

    tmpDirs.push(outside);
    fs.mkdirSync(path.join(outside, "node_modules", "extension"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "node_modules", "react"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "repo", dependencies: { react: "19" }, devDependencies: { extension: "latest" } }));
    fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Repo", version: "1.0.0" }));

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(installCalls).toEqual([]);
    expect(result.status).toBe("built");
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
