import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CARRIER_DIR_NAME,
  CARRIER_EXTENSION_ID,
  carrierPath,
  claimCarrier,
  materializeCarrier,
  removeCarrier,
} from "../lib/carrier";
import {
  installCarrierExitCleanup,
  sweepCarriers,
  uninstallCarrierExitCleanup,
} from "../lib/carrier-exit";
import {
  carriersPlacedHere,
  forgetCarrier,
  rememberCarrier,
  rememberedCarriers,
} from "../lib/carrier-registry";
import * as stop from "../tools/stop";

const MARKER = "managed-by-extension-dev-mcp.json";
const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-carrier-clean-"));
  tmpDirs.push(dir);
  return dir;
}

function withCarrier(): string {
  const dir = project();
  expect(materializeCarrier(dir, "chrome").loaded).toBe(true);
  return dir;
}

afterEach(() => {
  uninstallCarrierExitCleanup();
  for (const dir of tmpDirs.splice(0)) {
    forgetCarrier(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("a carrier this tool placed stays recognisable without its marker", () => {
  it("takes back its own payload when the marker is gone", () => {
    const dir = withCarrier();
    fs.rmSync(path.join(carrierPath(dir), MARKER));

    expect(claimCarrier(carrierPath(dir))).toEqual({
      ours: true,
      how: "payload",
    });
    const removal = removeCarrier(dir);
    expect(removal.removed).toBe(true);
    expect(removal.note).toContain(CARRIER_EXTENSION_ID);
    expect(fs.existsSync(carrierPath(dir))).toBe(false);
  });

  it("replaces its own unmarked payload instead of refusing forever", () => {
    const dir = withCarrier();
    fs.rmSync(path.join(carrierPath(dir), MARKER));

    const again = materializeCarrier(dir, "chrome");
    expect(again.loaded).toBe(true);
    expect(fs.existsSync(path.join(carrierPath(dir), MARKER))).toBe(true);
  });

  it("takes back a half-written copy that never got a manifest", () => {
    const dir = project();
    const target = carrierPath(dir);
    fs.mkdirSync(path.join(target, "action"), { recursive: true });
    fs.writeFileSync(path.join(target, "action", "index.css"), "");

    expect(claimCarrier(target)).toEqual({ ours: true, how: "partial" });
    expect(removeCarrier(dir).removed).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("still refuses a directory it never wrote, and says what to do instead", () => {
    const dir = project();
    const target = carrierPath(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "manifest.json"),
      JSON.stringify({ name: "someone else", version: "1.0.0" }),
    );

    const removal = removeCarrier(dir);
    expect(removal.removed).toBe(false);
    expect(removal.note).toContain("left untouched");
    expect(removal.note).toContain("rename it");
    expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);

    const materialized = materializeCarrier(dir, "chrome");
    expect(materialized.loaded).toBe(false);
    expect(materialized.note).toContain("Rename it");
  });

  it("refuses a directory holding files the payload never had", () => {
    const dir = project();
    const target = carrierPath(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "notes.txt"), "mine");

    expect(claimCarrier(target)).toEqual({ ours: false, how: "foreign" });
    expect(removeCarrier(dir).removed).toBe(false);
  });
});

describe("the carrier is written down so something can still find it later", () => {
  it("records a placed carrier and forgets a removed one", () => {
    const dir = withCarrier();
    expect(rememberedCarriers().map((p) => path.resolve(p))).toContain(
      path.resolve(dir),
    );
    expect(carriersPlacedHere()).toContain(path.resolve(dir));

    removeCarrier(dir);
    expect(rememberedCarriers().map((p) => path.resolve(p))).not.toContain(
      path.resolve(dir),
    );
    expect(carriersPlacedHere()).not.toContain(path.resolve(dir));
  });

  it("stops recording a project whose carrier was already gone", () => {
    const dir = project();
    rememberCarrier(dir);
    expect(rememberedCarriers().map((p) => path.resolve(p))).toContain(
      path.resolve(dir),
    );
    removeCarrier(dir);
    expect(rememberedCarriers().map((p) => path.resolve(p))).not.toContain(
      path.resolve(dir),
    );
  });
});

describe("extension_stop all=true reaches a project that was never stopped", () => {
  it("takes the carrier back with no session on record for it", async () => {
    const dir = withCarrier();

    const out = JSON.parse(await stop.handler({ all: true }));
    expect(fs.existsSync(carrierPath(dir))).toBe(false);
    const swept = (out.value.carriersSwept ?? []).map((c: any) =>
      path.resolve(c.projectPath),
    );
    expect(swept).toContain(path.resolve(dir));
    expect(out.warnings.join(" ")).toContain("no session left to stop it");
  });

  it("leaves a directory it does not own where it is", async () => {
    const dir = project();
    const target = carrierPath(dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "manifest.json"), '{"name":"theirs"}');
    rememberCarrier(dir);

    await stop.handler({ all: true });
    expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);
  });
});

describe("the server dying takes the carriers with it", () => {
  function ourListeners(signal: NodeJS.Signals): Array<(...a: any[]) => void> {
    return process.listeners(signal) as Array<(...a: any[]) => void>;
  }

  it("removes what this process placed when the server is signalled", () => {
    const dir = withCarrier();
    const keepAlive = () => {};
    process.on("SIGTERM", keepAlive);
    try {
      installCarrierExitCleanup();
      const ours = ourListeners("SIGTERM").filter((l) => l !== keepAlive);
      expect(ours).toHaveLength(1);

      ours[0]();

      expect(fs.existsSync(carrierPath(dir))).toBe(false);
      expect(carriersPlacedHere()).not.toContain(path.resolve(dir));
    } finally {
      process.off("SIGTERM", keepAlive);
    }
  });

  it("hands the signal back once nothing else is listening", () => {
    const keepAlive = () => {};
    process.on("SIGTERM", keepAlive);
    try {
      installCarrierExitCleanup();
      const before = process.listenerCount("SIGTERM");
      const ours = ourListeners("SIGTERM").filter((l) => l !== keepAlive);
      ours[0]();
      expect(process.listenerCount("SIGTERM")).toBe(before - 1);
      expect(process.listeners("SIGTERM")).toContain(keepAlive);
    } finally {
      process.off("SIGTERM", keepAlive);
    }
  });

  it("sweeps on a plain exit as well", () => {
    const dir = withCarrier();
    installCarrierExitCleanup();
    const exitHandlers = process.listeners("exit") as Array<() => void>;
    for (const handler of exitHandlers) handler();
    expect(fs.existsSync(carrierPath(dir))).toBe(false);
  });

  it("installs one set of handlers however often it is called", () => {
    const before = process.listenerCount("SIGINT");
    installCarrierExitCleanup();
    const after = process.listenerCount("SIGINT");
    installCarrierExitCleanup();
    installCarrierExitCleanup();
    expect(process.listenerCount("SIGINT")).toBe(after);
    expect(after).toBe(before + 1);
  });

  it("never throws when the project is already gone", () => {
    const dir = withCarrier();
    fs.rmSync(dir, { recursive: true, force: true });
    const keepAlive = () => {};
    process.on("SIGTERM", keepAlive);
    try {
      installCarrierExitCleanup();
      const ours = ourListeners("SIGTERM").filter((l) => l !== keepAlive);
      expect(() => ours[0]()).not.toThrow();
      expect(() => ours[0]()).not.toThrow();
    } finally {
      process.off("SIGTERM", keepAlive);
    }
  });

  it("is idempotent: a second sweep of the same project is a no-op", () => {
    const dir = withCarrier();
    expect(sweepCarriers([dir])[0].removed).toBe(true);
    expect(sweepCarriers([dir])).toEqual([]);
    expect(fs.existsSync(path.join(dir, "extensions", CARRIER_DIR_NAME))).toBe(
      false,
    );
  });
});
