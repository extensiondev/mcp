import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let carrier = await import("../lib/carrier");
let carrierExit = await import("../lib/carrier-exit");
let registry = await import("../lib/carrier-registry");
let processManager = await import("../lib/process-manager");
let stop = await import("../tools/stop");

const MARKER = "managed-by-extension-dev-mcp.json";
const CARRIER_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6QM4Vy/P3tIFJ+Jq7VyFEka5PICvw3LelaERWJzfVJ4avVWUfEa6vLX2+3Y21rmZ4nm2HhC203QWWRg24uCFlQWsyE9f3EW8yYR6HDvdTCPQxwq5Fv+d5m3YcNztse5IIf1XgnbZoCurI98CEHVilB4c8m6Yoel+PnPlRSjzkV5TjPyQ1NhZWfYfENAYmbxVzcpHD3eDFc9fveBvALOF9KU+21N2zubeLlnJlLjmDKv+Ud/zRLsMoc/5/zhdSE+rV/8DmA8ghyXeMQJ+WmjMgiBz/7wgg3Q1q0Bx1bzfMl18dO1pUjbW6nQC+CIxDBDthJpN4rSwuE/Xt3nEJZ5HtQIDAQAB";
const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-carrier-clean-"));
  tmpDirs.push(dir);

  return dir;
}

function placedByAnEarlierServer(dir: string, withMarker = true): string {
  const target = carrier.carrierPath(dir);
  fs.mkdirSync(path.join(target, "action"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "manifest.json"),
    JSON.stringify({ name: "Extension.dev Live Preview", version: "0.0.2", key: CARRIER_MANIFEST_KEY }),
  );

  fs.writeFileSync(path.join(target, "action", "index.css"), "");
  if (withMarker) fs.writeFileSync(path.join(target, MARKER), "{}");

  return target;
}

function recordedByAnEarlierServer(dir: string): void {
  const resolved = path.resolve(dir);
  const digest = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 16);
  const recordDir = path.join(processManager.sessionStateDir(), "carriers");
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordDir, `${digest}.json`),
    `${JSON.stringify({ projectPath: resolved, pid: 1, placedAt: "2026-10-01T00:00:00.000Z" })}\n`,
  );
}

beforeEach(async () => {
  vi.resetModules();
  carrier = await import("../lib/carrier");
  carrierExit = await import("../lib/carrier-exit");
  registry = await import("../lib/carrier-registry");
  processManager = await import("../lib/process-manager");
  stop = await import("../tools/stop");
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    registry.forgetCarrier(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("a carrier an earlier server placed is still recognised and taken back", () => {
  it("takes back a marked copy", () => {
    const dir = project();
    placedByAnEarlierServer(dir);

    const removal = carrier.removeCarrier(dir);
    expect(removal.removed).toBe(true);
    expect(removal.note).toBeUndefined();
    expect(fs.existsSync(carrier.carrierPath(dir))).toBe(false);
  });

  it("takes back its own payload when the marker is gone, by the manifest key", () => {
    const dir = project();
    placedByAnEarlierServer(dir, false);

    const removal = carrier.removeCarrier(dir);
    expect(removal.removed).toBe(true);
    expect(removal.note).toContain(carrier.CARRIER_EXTENSION_ID);
    expect(fs.existsSync(carrier.carrierPath(dir))).toBe(false);
  });

  it("still refuses a directory it never wrote, and says what to do instead", () => {
    const dir = project();
    const target = carrier.carrierPath(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "manifest.json"),
      JSON.stringify({ name: "someone else", version: "1.0.0" }),
    );

    const removal = carrier.removeCarrier(dir);
    expect(removal.removed).toBe(false);
    expect(removal.note).toContain("left untouched");
    expect(removal.note).toContain("rename it");
    expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);
  });

  it("refuses a directory with no marker and no manifest", () => {
    const dir = project();
    const target = carrier.carrierPath(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "notes.txt"), "mine");

    expect(carrier.removeCarrier(dir).removed).toBe(false);
    expect(fs.existsSync(path.join(target, "notes.txt"))).toBe(true);
  });
});

describe("the records an earlier server wrote still lead extension_stop to its carriers", () => {
  it("reads a record and forgets it once the carrier is gone", () => {
    const dir = project();
    recordedByAnEarlierServer(dir);
    expect(registry.readRememberedCarriers().carriers).toContain(path.resolve(dir));

    carrier.removeCarrier(dir);
    expect(registry.readRememberedCarriers().carriers).not.toContain(path.resolve(dir));
  });

  it("takes the carrier back with no session on record for it", async () => {
    const dir = project();
    placedByAnEarlierServer(dir);
    recordedByAnEarlierServer(dir);

    const out = JSON.parse(await stop.handler({ all: true }));
    expect(fs.existsSync(carrier.carrierPath(dir))).toBe(false);
    const swept = (out.value.carriersSwept ?? []).map((c: any) =>
      path.resolve(c.projectPath),
    );
    expect(swept).toContain(path.resolve(dir));
    expect(out.warnings.join(" ")).toContain("no session left to stop it");
  });

  it("leaves a directory it does not own where it is", async () => {
    const dir = project();
    const target = carrier.carrierPath(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "manifest.json"), '{"name":"theirs"}');
    recordedByAnEarlierServer(dir);

    await stop.handler({ all: true });
    expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);
  });

  it("is idempotent: a second sweep of the same project is a no-op", () => {
    const dir = project();
    placedByAnEarlierServer(dir);
    expect(carrierExit.sweepCarriers([dir])[0].removed).toBe(true);
    expect(carrierExit.sweepCarriers([dir])).toEqual([]);
    expect(fs.existsSync(carrier.carrierPath(dir))).toBe(false);
  });

  it("never throws when the project is already gone", () => {
    const dir = project();
    placedByAnEarlierServer(dir);
    fs.rmSync(dir, { recursive: true, force: true });

    expect(() => carrierExit.sweepCarriers([dir])).not.toThrow();
  });
});
