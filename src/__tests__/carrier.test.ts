import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CARRIER_DIR_NAME,
  CARRIER_EXTENSION_ID,
  materializeCarrier,
} from "../lib/carrier";

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

  it("hands over the protocol needed to actually drive the real lane", () => {
    const result = materializeCarrier(projectDir, "chrome");
    const protocol = result.bridgeProtocol;
    expect(protocol).toBeDefined();
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, "extensions", CARRIER_DIR_NAME, "manifest.json"),
        "utf-8",
      ),
    ) as { key?: string };
    const expected = [
      ...createHash("sha256")
        .update(Buffer.from(manifest.key ?? "", "base64"))
        .digest()
        .subarray(0, 16),
    ]
      .map(
        (byte) =>
          String.fromCharCode(97 + (byte >> 4)) +
          String.fromCharCode(97 + (byte & 15)),
      )
      .join("");
    expect(protocol?.carrierExtensionId).toBe(expected);
    expect(protocol?.carrierExtensionId).toMatch(/^[a-p]{32}$/);
    expect(protocol?.example).toContain("extensiondev:session");
    expect(protocol?.example).toContain("extensiondev:bridge");
    expect(protocol?.example).toContain("EXTENSION_BRIDGE_REQUEST");
    expect(protocol?.example).toContain(protocol?.carrierExtensionId ?? "");
    expect(protocol?.example).not.toContain("storage.local.get");
    expect(protocol?.howTo).toContain("storage.local.get");
  });

  it("states its limitations instead of leaving them to be discovered", () => {
    const result = materializeCarrier(projectDir, "chrome");
    const text = (result.limitations ?? []).join(" ");
    expect(text).toMatch(/own chrome\.\* calls .*never cross the carrier/i);
    expect(text).toMatch(/CARRIER's identity/i);
  });

  it("keeps the stable carrier id in step with what the payload derives", () => {
    const result = materializeCarrier(projectDir, "chrome");
    expect(result.bridgeProtocol?.carrierExtensionId).toBe(CARRIER_EXTENSION_ID);
  });

  it("names the graduation path to the guest's own isolated state", () => {
    const result = materializeCarrier(projectDir, "chrome");
    const g = result.graduation ?? "";
    expect(g).toMatch(/already loaded as ITSELF/i);
    expect(g).toMatch(
      /extension_storage|extension_eval|extension_dom_snapshot/,
    );
    expect(g).toMatch(/allowControl|allowEval/);
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
