import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CARRIER_DIR_NAME, materializeCarrier } from "../lib/carrier";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-carrier-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("materializeCarrier", () => {
  it("refuses non-chromium families with an honest note", () => {
    const result = materializeCarrier(projectDir, "firefox");
    expect(result.loaded).toBe(false);
    expect(result.note).toMatch(/Chromium-family only/);
    expect(fs.existsSync(path.join(projectDir, "extensions"))).toBe(false);
  });

  it("places the bundled carrier with the managed marker", () => {
    const result = materializeCarrier(projectDir, "chrome");
    expect(result.loaded).toBe(true);
    const target = path.join(projectDir, "extensions", CARRIER_DIR_NAME);
    expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(target, "managed-by-extension-dev-mcp.json")),
    ).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(target, "manifest.json"), "utf-8"),
    ) as { name?: string };
    expect(manifest.name).toMatch(/Live Preview/);
  });

  it("replaces its own managed copy on a second run", () => {
    expect(materializeCarrier(projectDir, "chrome").loaded).toBe(true);
    const target = path.join(projectDir, "extensions", CARRIER_DIR_NAME);
    fs.writeFileSync(path.join(target, "stale-file.txt"), "old");
    const result = materializeCarrier(projectDir, "chrome");
    expect(result.loaded).toBe(true);
    expect(fs.existsSync(path.join(target, "stale-file.txt"))).toBe(false);
  });

  it("never clobbers an unmanaged directory of the same name", () => {
    const target = path.join(projectDir, "extensions", CARRIER_DIR_NAME);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "manifest.json"), "{}");
    const result = materializeCarrier(projectDir, "chrome");
    expect(result.loaded).toBe(false);
    expect(result.note).toMatch(/left untouched/);
    expect(fs.readFileSync(path.join(target, "manifest.json"), "utf-8")).toBe(
      "{}",
    );
  });
});
