import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const { readZipEntryNames } = await import("../lib/zip-entries");

function storedZip(entries: Array<[string, string]>): Buffer {
  const bodies: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    bodies.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const body = Buffer.concat(bodies);
  const central = Buffer.concat(directory);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, eocd]);
}
const { CARRIER_DIR_NAME, materializeCarrier, removeCarrier } = await import(
  "../lib/carrier"
);

const MARKER = "managed-by-extension-dev-mcp.json";
const tmpDirs: string[] = [];

function project(): string {
  /* @invariant The prefix deliberately avoids the word this file greps for. Warnings now
     quote absolute paths, so a fixture directory named after the thing being
     asserted absent makes the assertion match its own scaffolding. Renaming the
     fixture keeps the /carrier/i check at full strength; loosening the check
     instead would have blunted the guard to accommodate a temp directory. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-ship-"));
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

    expect(result.ok).toBe(false);
    expect(result.status).toBe("carrier-in-dist");
    expect(result.error.code).toBe("E_CARRIER_IN_DIST");
    expect(result.error.message).toMatch(/not safe to submit/);
  });

  it("refuses a build whose source zip packs the carrier", async () => {
    const dir = project();
    projectAtCliTime = dir;
    const dist = path.join(dir, "dist");
    fs.mkdirSync(path.join(dist, "chrome"), { recursive: true });
    fs.writeFileSync(
      path.join(dist, "chrome", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "probe", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(dist, "probe-1.0.0-source.zip"),
      storedZip([
        ["src/manifest.json", "{}"],
        [`extensions/${CARRIER_DIR_NAME}/manifest.json`, "{}"],
        [`extensions/${CARRIER_DIR_NAME}/${MARKER}`, "{}"],
      ]),
    );

    const result = JSON.parse(
      await build.handler({
        projectPath: dir,
        skipValidation: true,
        zipSource: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("carrier-in-dist");
    expect(result.error.code).toBe("E_CARRIER_IN_DIST");
    expect(result.error.message).toContain("probe-1.0.0-source.zip");
    expect(result.error.message).toContain(CARRIER_DIR_NAME);
    expect(result.hint).toContain("--zip-source");
  });

  it("refuses a carrier left in another browser's output", async () => {
    const dir = project();
    projectAtCliTime = dir;
    const dist = path.join(dir, "dist");
    fs.mkdirSync(path.join(dist, "chrome"), { recursive: true });
    fs.writeFileSync(
      path.join(dist, "chrome", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "probe", version: "1.0.0" }),
    );
    fs.mkdirSync(path.join(dist, "edge", "extensions", CARRIER_DIR_NAME), {
      recursive: true,
    });

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("carrier-in-dist");
    expect(result.error.message).toContain(path.join("dist", "edge"));
  });

  it("says an archive went unchecked rather than passing it as clean", async () => {
    const dir = project();
    projectAtCliTime = dir;
    const dist = path.join(dir, "dist", "chrome");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "probe", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(dist, "broken.zip"), "not really a zip at all");

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("broken.zip");
    expect(result.warnings.join(" ")).toContain("not checked");
  });

  it("says nothing about the carrier when there never was one", async () => {
    const dir = project();
    projectAtCliTime = dir;

    const result = JSON.parse(
      await build.handler({ projectPath: dir, skipValidation: true }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.warnings ?? [])).not.toMatch(/carrier/i);
  });
});

describe("reading a zip's table of contents", () => {
  it("lists every entry a stored archive declares", () => {
    const dir = project();
    const zip = path.join(dir, "sample.zip");
    fs.writeFileSync(
      zip,
      storedZip([
        ["a.txt", "one"],
        ["nested/deep/b.txt", "two"],
      ]),
    );
    expect(readZipEntryNames(zip)).toEqual({
      names: ["a.txt", "nested/deep/b.txt"],
      readable: true,
    });
  });

  it("calls a file it cannot parse unreadable, never empty and fine", () => {
    const dir = project();
    const junk = path.join(dir, "junk.zip");
    fs.writeFileSync(junk, "PK not really a zip either way at all here");
    expect(readZipEntryNames(junk).readable).toBe(false);

    const missing = path.join(dir, "absent.zip");
    expect(readZipEntryNames(missing).readable).toBe(false);
  });

  it("refuses an archive whose directory does not match its own count", () => {
    const dir = project();
    const zip = path.join(dir, "lying.zip");
    const bytes = storedZip([["a.txt", "one"]]);
    bytes.writeUInt16LE(9, bytes.length - 22 + 10);
    fs.writeFileSync(zip, bytes);
    expect(readZipEntryNames(zip).readable).toBe(false);
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
