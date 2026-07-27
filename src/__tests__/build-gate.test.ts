import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cliCalls: string[][] = [];
let cliResultOverride: { code: number; stdout: string; stderr: string } | null =
  null;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      return (
        cliResultOverride ?? {
          code: 0,
          stdout: "Build Status: success\nSize: 12 kB",
          stderr: "",
        }
      );
    },
  };
});

const build = await import("../tools/build");

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
        action: { default_popup: "popup.html" },
      },
      ["popup.html"],
    );

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.join(" ").toLowerCase()).toContain("version");
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

  it("returns the absolute path of the zip the engine actually wrote", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "chrome", "zipprobeext-1.0.0.zip");
    fs.writeFileSync(zip, "PK");

    const result = JSON.parse(
      await build.handler({ projectPath: dir, zip: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.zipPath).toBe(zip);
    expect(result.warnings.join(" ")).not.toContain("no .zip file");
  });

  it("mirrors the engine's sanitization of a custom zipFilename", async () => {
    const dir = builtProject("zip-probe-ext");
    const zip = path.join(dir, "dist", "chrome", "my-customname-v2.zip");
    fs.writeFileSync(zip, "PK");

    const result = JSON.parse(
      await build.handler({
        projectPath: dir,
        zip: true,
        zipFilename: "My Custom-Name v2",
      }),
    );

    expect(result.value.zipPath).toBe(zip);
  });

  it("falls back to the freshest zip when the name cannot be predicted", async () => {
    const dir = builtProject("__MSG_appName__");
    const zip = path.join(dir, "dist", "chrome", "meine-erweiterung-1.0.0.zip");
    fs.writeFileSync(zip, "PK");
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(zip, future, future);

    const result = JSON.parse(
      await build.handler({ projectPath: dir, zip: true }),
    );

    expect(result.value.zipPath).toBe(zip);
  });

  it("says so explicitly when the zip cannot be located", async () => {
    const dir = builtProject("zip-probe-ext");

    const result = JSON.parse(
      await build.handler({ projectPath: dir, zip: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.value.zipPath).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("dist/chrome");
  });

  it("reports the source zip from the dist ROOT, where the engine writes it", async () => {
    const dir = builtProject("zip-probe-ext");
    const sourceZip = path.join(dir, "dist", "zipprobeext-1.0.0-source.zip");
    fs.writeFileSync(sourceZip, "PK");

    const result = JSON.parse(
      await build.handler({ projectPath: dir, zipSource: true }),
    );

    expect(result.value.zipSourcePath).toBe(sourceZip);
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

  it("carries the warning on a failed build too, the dist may be half rewritten", async () => {
    const dir = project({ manifest_version: 3, name: "F", version: "1.0.0" });
    writeReadyContract(dir, "chrome", process.pid);
    cliResultOverride = { code: 1, stdout: "", stderr: "boom" };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("dev session");
  });
});
