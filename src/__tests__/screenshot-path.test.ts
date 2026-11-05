import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveScreenshotPath, sanctionedScreenshotRoots, screenshotsDir, writeScreenshot } from "../lib/capture";
import { setClientRoots } from "../lib/client-roots";
import { readyContractPath } from "../lib/session-paths";
import { readyContract } from "./fixtures/engine-answers";
import { solidPng } from "./fixtures/png";

const screenshot = await import("../tools/screenshot");

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function homeDir(prefix: string): string {
  const parent = path.join(os.homedir(), ".mcp-screenshot-path-tests");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function projectOutsideTemp(): string {
  const dir = path.join(homeDir("project-"), "project");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Shot", version: "1.0.0" }));

  return dir;
}

function project(): string {
  const dir = path.join(tempDir("mcp-screenshot-path-"), "project");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Shot", version: "1.0.0" }));

  return dir;
}

function write(dir: string, wanted?: string) {
  return writeScreenshot(dir, "chrome", "page", solidPng(4, 4), wanted);
}

function expectRefused(dir: string, wanted: string): { message: string; hint: string } {
  const before = fs.readdirSync(dir).sort();
  const out = write(dir, wanted);

  expect(out.ok).toBe(false);
  if (out.ok) throw new Error("unreachable");

  expect(fs.readdirSync(dir).sort()).toEqual(before);

  return out;
}

describe("writeScreenshot keeps the file inside the project as a .png", () => {
  it("writes the default name under the session screenshots folder when no path is given", () => {
    const dir = project();

    const out = write(dir);

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    expect(path.dirname(out.file)).toBe(screenshotsDir(dir, "chrome"));
    expect(out.file.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(out.file).equals(solidPng(4, 4))).toBe(true);
  });

  it("accepts a relative .png path that resolves inside the project and creates its folders", () => {
    const dir = project();

    const out = write(dir, "shots/home.png");

    expect(out).toEqual({ ok: true, file: path.join(dir, "shots", "home.png") });
    expect(fs.existsSync(path.join(dir, "shots", "home.png"))).toBe(true);
  });

  it("accepts an absolute .png path that lies inside the project", () => {
    const dir = project();

    const out = write(dir, path.join(dir, "shots", "home.png"));

    expect(out).toEqual({ ok: true, file: path.join(dir, "shots", "home.png") });
  });

  it("refuses an absolute path outside the project and writes nothing there", () => {
    const dir = project();
    const elsewhere = homeDir("elsewhere-");
    const file = path.join(elsewhere, "shot.png");

    const out = expectRefused(dir, file);

    expect(out.message).toContain("inside the project");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a ../ escape out of the project", () => {
    const dir = projectOutsideTemp();
    const parent = path.dirname(dir);

    const out = expectRefused(dir, "../escaped.png");

    expect(out.message).toContain("inside the project");
    expect(fs.readdirSync(parent)).toEqual(["project"]);
  });

  it("refuses a path whose extension is not .png, so a source file is never overwritten", () => {
    const dir = project();
    const manifest = path.join(dir, "src", "manifest.json");
    const source = fs.readFileSync(manifest, "utf8");

    const out = expectRefused(dir, "src/manifest.json");

    expect(out.message).toContain(".png");
    expect(out.hint).toContain("/");
    expect(fs.readFileSync(manifest, "utf8")).toBe(source);
  });

  it("refuses a path that is neither a .png nor a folder instead of writing a bare file named after it", () => {
    const dir = project();

    const out = expectRefused(dir, "shots");

    expect(out.message).toContain(".png");
    expect(out.hint).toMatch(/shots\//);
    expect(fs.existsSync(path.join(dir, "shots"))).toBe(false);
  });

  it("writes the default name into a folder named with a trailing slash", () => {
    const dir = project();

    const out = write(dir, "shots/");

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    expect(path.dirname(out.file)).toBe(path.join(dir, "shots"));
    expect(path.basename(out.file)).toMatch(/^page-.*\.png$/);
    expect(fs.statSync(path.join(dir, "shots")).isDirectory()).toBe(true);
  });

  it("writes the default name into an existing folder named without a trailing slash", () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, "shots"));

    const out = write(dir, "shots");

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    expect(path.dirname(out.file)).toBe(path.join(dir, "shots"));
    expect(path.basename(out.file)).toMatch(/^page-.*\.png$/);
  });
});

describe("extension_screenshot refuses a bad path before asking the browser for pixels", () => {
  function session(): string {
    const dir = project();
    fs.mkdirSync(path.join(dir, "dist", "chrome"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "chrome", "manifest.json"), fs.readFileSync(path.join(dir, "src", "manifest.json")));
    const ready = readyContractPath(dir, "chrome");
    fs.mkdirSync(path.dirname(ready), { recursive: true });
    fs.writeFileSync(ready, JSON.stringify({ ...readyContract("dev", "chrome"), distPath: path.join(dir, "dist", "chrome") }));

    return dir;
  }

  const run = async (args: Parameters<typeof screenshot.handler>[0]) => JSON.parse(await screenshot.handler(args));

  it("answers E_BAD_REQUEST with a hint for a path naming a source file, leaving it untouched", async () => {
    const dir = session();
    const manifest = path.join(dir, "src", "manifest.json");
    const source = fs.readFileSync(manifest, "utf8");

    const out = await run({ projectPath: dir, browser: "chrome", path: "src/manifest.json", timeout: 1000 });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain(".png");
    expect(typeof out.hint).toBe("string");
    expect(fs.readFileSync(manifest, "utf8")).toBe(source);
  });

  it("answers E_BAD_REQUEST for a path outside the project", async () => {
    const dir = session();
    const elsewhere = homeDir("elsewhere-");

    const out = await run({ projectPath: dir, browser: "chrome", path: path.join(elsewhere, "shot.png"), timeout: 1000 });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("inside the project");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

describe("400: a screenshot may land in the system temp folder or a client root, never anywhere else", () => {
  it("accepts an absolute .png path under the system temp folder", () => {
    const dir = project();
    const scratch = tempDir("mcp-screenshot-scratch-");
    const file = path.join(scratch, "me-pick.png");

    const out = write(dir, file);

    expect(out).toEqual({ ok: true, file });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("accepts a new folder under the temp folder and creates it", () => {
    const dir = project();
    const scratch = tempDir("mcp-screenshot-scratch-");
    const file = path.join(scratch, "deeper", "shots", "home.png");

    const out = write(dir, file);

    expect(out).toEqual({ ok: true, file });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("accepts a path under a client MCP root and refuses it once the root is gone", () => {
    const dir = project();
    const home = path.join(os.homedir(), ".mcp-screenshot-root-probe");
    setClientRoots([`file://${home}`]);

    const allowed = resolveScreenshotPath(dir, "chrome", "page", path.join(home, "shot.png"));
    setClientRoots(null);
    const refused = resolveScreenshotPath(dir, "chrome", "page", path.join(home, "shot.png"));

    expect(allowed.ok).toBe(true);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");

    expect(refused.message).toContain("client root");
    expect(refused.hint).toContain(os.tmpdir());
    expect(sanctionedScreenshotRoots(dir)).toContain(os.tmpdir());
  });

  it("still refuses the user's home and a sibling of a project outside the temp folder", () => {
    const dir = projectOutsideTemp();

    for (const wanted of [path.join(os.homedir(), "shot.png"), path.join(path.dirname(dir), "sibling.png")]) {
      const out = resolveScreenshotPath(dir, "chrome", "page", wanted);

      expect(out.ok).toBe(false);
    }
  });
});
