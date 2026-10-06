import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cliCalls: string[][] = [];
let cliResultOverride: { code: number; stdout: string; stderr: string } | null =
  null;
let onCli: ((args: string[]) => void) | null = null;
let skipDist = false;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      onCli?.(args);
      const answer = cliResultOverride ?? {
        code: 0,
        stdout: "Build Status: success\nSize: 12 kB",
        stderr: "",
      };
      if (answer.code === 0 && !skipDist) writeEngineDist(args[1]!, browserFromCliArgs(args));
      return answer;
    },
  };
});

const build = await import("../tools/build");
const { buildSummaryPath } = await import("../lib/session-paths");
const { buildSummary, zipArtifacts, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];
function project(manifest: Record<string, unknown>, files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-gate-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
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

afterEach(() => {
  cliCalls.length = 0;
  cliResultOverride = null;
  onCli = null;
  skipDist = false;
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    expect(result.warnings.join(" ").toLowerCase()).toContain("128x128 icon");
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

describe("extension_build warns over a live dev session", () => {
  function writeReadyContract(dir: string, browser: string, pid: number): void {
    const contractDir = path.join(dir, "dist", "extension-js", browser);
    fs.mkdirSync(contractDir, { recursive: true });
    fs.writeFileSync(
      path.join(contractDir, "ready.json"),
      JSON.stringify({ status: "ready", pid }),
    );
  }

  it("warns that the build wrote over the live session's dist", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "chrome", process.pid);

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(cliCalls).toHaveLength(1);
    expect(Array.isArray(result.warnings)).toBe(true);
    const warning = result.warnings.join(" ");
    expect(warning).toContain("dev session");
    expect(warning).toContain("dist/chrome");
    expect(warning).toContain("production artifact");
    expect(warning).toContain("extension_stop");
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

  it("does not say a failed build wrote over the dev dist: the engine promotes its staging dir only on success", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "chrome", process.pid);
    cliResultOverride = { code: 1, stdout: "", stderr: "boom" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).not.toMatch(/wrote over its dist/);
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
