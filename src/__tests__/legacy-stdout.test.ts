import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_FIDELITY_WARNING,
  denoiseCliLog,
  legacyCompileScrape,
  legacyProfileLockScrape,
} from "../lib/legacy-stdout";
import { pollBootVerdict, speaksMachineContract } from "../lib/boot-verdict";
import { readyContractPath } from "../lib/session-paths";
import {
  writePreSchema1ContractError,
  writeSchema1ContractError,
} from "./fixtures/ready-contract";

import type { ChildProcess } from "node:child_process";

const srcDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("the deprecated stdout fallback", () => {
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

describe("the scrapes are still reachable, and only below the 4.0.17 schema-1 floor", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function projectWithContract(contract: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-legacy-floor-"));
    tmpDirs.push(dir);
    const file = readyContractPath(dir, "chrome");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(contract));

    return dir;
  }

  const liveChild = {
    exitCode: null,
    signalCode: null,
  } as unknown as ChildProcess;

  const preSchemaContract = {
    schemaVersion: 2,
    status: "starting",
    command: "dev",
    browser: "chrome",
    pid: process.pid,
  };

  async function verdictFor(
    contract: Record<string, unknown>,
    output: string,
  ) {
    return pollBootVerdict(projectWithContract(contract), "chrome", {
      child: liveChild,
      readOutput: () => output,
      budgetMs: 50,
      since: 0,
      intervalMs: 10,
    });
  }

  it("reads a compile failure off stdout when the contract predates schema 1", async () => {
    const reading = await verdictFor(
      preSchemaContract,
      "✖✖✖ Probe compiled with errors in 180 ms.",
    );

    expect(reading.machineContract).toBe(false);
    expect(reading.verdict.kind).toBe("compile-failed");
    expect(reading.warnings).toContain(LEGACY_FIDELITY_WARNING);
  });

  it("reads a locked profile off stdout when the contract predates schema 1", async () => {
    const reading = await verdictFor(
      preSchemaContract,
      "Failed to create SingletonLock: File exists",
    );

    expect(reading.verdict.kind).toBe("profile-locked");
    expect(reading.warnings).toContain(LEGACY_FIDELITY_WARNING);
  });

  it("never scrapes once the contract says schema 1, however the output reads", async () => {
    const reading = await verdictFor(
      { ...preSchemaContract, schema: 1 },
      "✖✖✖ Probe compiled with errors in 180 ms.\nSingletonLock",
    );

    expect(reading.machineContract).toBe(true);
    expect(reading.verdict.kind).toBe("alive");
    expect(reading.warnings).toEqual([]);
  });

  it("keeps one fixture below the floor and one above it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-legacy-fixture-"));
    tmpDirs.push(dir);

    const read = (file: string) =>
      JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

    const below = read(writePreSchema1ContractError(dir, "chrome"));
    const above = read(writeSchema1ContractError(dir, "firefox"));

    expect(speaksMachineContract(below)).toBe(false);
    expect(speaksMachineContract(above)).toBe(true);
    expect(below.status).toBe("error");
    expect(above.status).toBe("error");
  });

  it("pins an engine above the floor, and still cannot assume the project runs it", () => {
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(
          srcDir,
          "..",
          "node_modules",
          "extension-develop",
          "package.json",
        ),
        "utf8",
      ),
    ).version as string;
    const release = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(installed);

    if (!release) {
      throw new Error(`engine version is not a semver release: ${installed}`);
    }

    const [major, minor, patch] = release.slice(1).map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(
      4 * 1_000_000 + 0 * 1_000 + 17,
    );
  });
});
