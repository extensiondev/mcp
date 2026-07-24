import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The carrier must be gone BEFORE the CLI runs, so the CLI is stubbed and the
// removal is asserted from the callback the stub fires.
let carrierAtCliTime: boolean | null = null;
let projectAtCliTime: string | null = null;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async () => {
      carrierAtCliTime =
        projectAtCliTime === null
          ? null
          : fs.existsSync(
              path.join(
                projectAtCliTime,
                "extensions",
                "extension-dev-live-preview",
              ),
            );
      return { code: 0, stdout: "Build Status: success", stderr: "" };
    },
  };
});

const build = await import("../tools/build");
const stop = await import("../tools/stop");
const { CARRIER_DIR_NAME, materializeCarrier, removeCarrier } = await import(
  "../lib/carrier"
);

const MARKER = "managed-by-extension-dev-mcp.json";
const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-carrier-ship-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "probe", version: "1.0.0" }),
  );
  return dir;
}

function carrierDir(dir: string): string {
  return path.join(dir, "extensions", CARRIER_DIR_NAME);
}

function placeCarrier(dir: string, managed = true): string {
  const target = carrierDir(dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "manifest.json"), "{}");
  if (managed) fs.writeFileSync(path.join(target, MARKER), "{}");
  return target;
}

afterEach(() => {
  carrierAtCliTime = null;
  projectAtCliTime = null;
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the carrier never reaches a build", () => {
  it("removes its own carrier before the CLI runs and says it did", async () => {
    const dir = project();
    projectAtCliTime = dir;
    placeCarrier(dir);

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(carrierAtCliTime).toBe(false);
    expect(fs.existsSync(carrierDir(dir))).toBe(false);
    // The empty scaffolding goes too; the folder was ours only while the
    // carrier was in it.
    expect(fs.existsSync(path.join(dir, "extensions"))).toBe(false);
    expect((result.warnings ?? []).join(" ")).toMatch(
      /Removed the Extension\.dev live-preview carrier/,
    );
  });

  it("leaves a directory that is not ours alone, and reports that", async () => {
    const dir = project();
    projectAtCliTime = dir;
    const target = placeCarrier(dir, false);

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(fs.existsSync(target)).toBe(true);
    expect((result.warnings ?? []).join(" ")).toMatch(/left untouched/);
  });

  it("refuses to call a build clean when the carrier is in dist", async () => {
    const dir = project();
    projectAtCliTime = dir;
    const dist = path.join(dir, "dist", "chrome");
    fs.mkdirSync(path.join(dist, "extensions", CARRIER_DIR_NAME), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "probe", version: "1.0.0" }),
    );

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("contaminated");
    expect(result.error).toMatch(/not safe to submit/);
  });

  it("says nothing about the carrier when there never was one", async () => {
    const dir = project();
    projectAtCliTime = dir;

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.warnings ?? [])).not.toMatch(/carrier/i);
  });
});

describe("removeCarrier", () => {
  it("is marker-guarded", () => {
    const dir = project();
    const target = placeCarrier(dir, false);
    const removal = removeCarrier(dir);
    expect(removal.removed).toBe(false);
    expect(removal.note).toMatch(/no managed-by-extension-dev-mcp\.json marker/);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("reports nothing to do on a project that never had one", () => {
    const dir = project();
    expect(removeCarrier(dir).removed).toBe(false);
  });
});

describe("extension_stop", () => {
  it("takes the carrier back out of the project", async () => {
    const dir = project();
    placeCarrier(dir);
    const outcome = await stop.stopOne(dir, "chrome");
    expect(outcome.carrierRemoved).toBe(carrierDir(dir));
    expect(fs.existsSync(carrierDir(dir))).toBe(false);
  });
});

describe("materializeCarrier", () => {
  it("gitignores itself in a git project so the first add -A cannot vendor it", () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, ".git"));
    const result = materializeCarrier(dir, "chrome");
    expect(result.loaded).toBe(true);
    expect(result.gitignored).toBe(`extensions/${CARRIER_DIR_NAME}/`);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toContain(
      `extensions/${CARRIER_DIR_NAME}/`,
    );
    // Idempotent: a second run adds nothing.
    materializeCarrier(dir, "chrome");
    const lines = fs
      .readFileSync(path.join(dir, ".gitignore"), "utf-8")
      .split("\n")
      .filter((line) => line.trim() === `extensions/${CARRIER_DIR_NAME}/`);
    expect(lines).toHaveLength(1);
  });

  it("respects a project that already ignores the whole folder", () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\nextensions/\n");
    const result = materializeCarrier(dir, "chrome");
    expect(result.gitignored).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toBe(
      "node_modules\nextensions/\n",
    );
  });

  it("writes no .gitignore into a project that is not a git repo", () => {
    const dir = project();
    expect(materializeCarrier(dir, "chrome").loaded).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });
});
