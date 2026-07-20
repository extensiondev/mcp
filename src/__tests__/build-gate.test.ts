import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The gate must decide BEFORE the CLI runs, so the CLI is stubbed: any call to
// it in a blocked case is itself the failure.
const cliCalls: string[][] = [];
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      return { code: 0, stdout: "Build Status: success\nSize: 12 kB", stderr: "" };
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
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_build validation gate", () => {
  it("refuses to build a manifest with build-blocking errors", async () => {
    // No name: manifest_validate treats a missing required field as an error.
    const dir = project({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.errors.join(" ")).toContain("name");
    expect(result.hint).toContain("skipValidation");
    // The whole point: we never shelled out to a build we knew was broken.
    expect(cliCalls).toHaveLength(0);
  });

  it("builds anyway under skipValidation, as an explicit escape hatch", async () => {
    const dir = project({ manifest_version: 3, version: "1.0.0" });

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.success).toBe(true);
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

    expect(result.success).toBe(true);
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toContain("build");
  });

  // A zero exit code is the bundler's verdict, not the artifact's: if a
  // declared entrypoint never made it into dist, Chrome refuses to load the
  // build, so success:true would be a lie.
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
    // Built manifest declares popup.html, but dist never received it.
    const distDir = path.join(dir, "dist", "chrome");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "manifest.json"),
      JSON.stringify({ action: { default_popup: "popup.html" } }),
    );

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.buildExitCode).toBe(0);
    expect(result.error).toContain("popup.html");
    expect(result.error).toContain("refuse to load");
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

    expect(result.success).toBe(true);
  });

  // A dangling path reference USED to ride out of a green build as a warning.
  // The swarm proved build actually fails on the same tree (persona C12 had the
  // warning prose and green machine fields in one payload), so it now blocks.
  it("blocks on a dangling path reference instead of warning about it", async () => {
    const dir = project({
      manifest_version: 3,
      name: "Fixture",
      version: "1.0.0",
      action: { default_popup: "nope.html" },
    });

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.errors.join(" ")).toContain("nope.html");
    expect(cliCalls).toHaveLength(0);
  });

  it("still carries genuinely non-blocking warnings out of a green build", async () => {
    // Missing version is a store-submission warning, not a load failure.
    const dir = project(
      {
        manifest_version: 3,
        name: "Fixture",
        action: { default_popup: "popup.html" },
      },
      ["popup.html"],
    );

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.success).toBe(true);
    expect(Array.isArray(result.manifestWarnings)).toBe(true);
    expect(result.manifestWarnings.join(" ").toLowerCase()).toContain("version");
  });
});
