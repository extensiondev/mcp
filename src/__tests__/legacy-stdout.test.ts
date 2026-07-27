import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  denoiseCliLog,
  legacyCompileScrape,
  legacyProfileLockScrape,
} from "../lib/legacy-stdout";
import { speaksMachineContract } from "../lib/boot-verdict";

const srcDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("the deprecated stdout fallback", () => {
  it("declares when it can be deleted", () => {
    const source = fs.readFileSync(
      path.join(srcDir, "lib", "legacy-stdout.ts"),
      "utf8",
    );
    expect(source).toContain("@deprecated");
    expect(source).toContain("schema: 1");
  });

  it("drops npm's cold-install notice, which reads as a compile failure", () => {
    const raw = [
      "npm warn exec The following package was not found and will be installed: extension@4.0.16",
      "ready in 300ms",
    ].join("\n");
    expect(legacyCompileScrape(raw)).toBe(true);
    expect(legacyCompileScrape(denoiseCliLog(raw))).toBe(false);
    expect(denoiseCliLog(raw)).toBe("ready in 300ms");
  });

  it("drops V8 asm.js chatter and keeps real output", () => {
    const raw = [
      "(node:66923) V8: /x/lexer.asm.js:2 Invalid asm.js: Invalid return type",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "Invalid asm.js: Unexpected token",
      "Linking failure in asm.js: Unexpected stdlib member",
      "ready in 300ms",
    ].join("\n");
    const clean = denoiseCliLog(raw);
    expect(clean).not.toContain("asm.js");
    expect(clean).not.toContain("trace-warnings");
    expect(clean).toContain("ready in 300ms");
  });

  it("still recognises a compile failure and a locked profile in raw output", () => {
    expect(
      legacyCompileScrape("✖✖✖ Probe compiled with errors in 180 ms."),
    ).toBe(true);
    expect(legacyCompileScrape("ready in 300ms")).toBe(false);
    expect(
      legacyProfileLockScrape("Failed to create SingletonLock: File exists"),
    ).toBe(true);
    expect(legacyProfileLockScrape("ready in 300ms")).toBe(false);
  });
});

describe("the capability probe", () => {
  it("reads the artefact, never the pinned version", () => {
    expect(speaksMachineContract({ schema: 1, status: "error" })).toBe(true);
    expect(speaksMachineContract({ schemaVersion: 2, status: "error" })).toBe(
      false,
    );
    expect(speaksMachineContract({ schema: "1" })).toBe(false);
    expect(speaksMachineContract(null)).toBe(false);
  });
});
