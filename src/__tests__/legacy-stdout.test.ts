import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
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

/* @invariant What the exemption in no-prose-scraping is actually buying, asserted
   rather than argued. The probe keys on `schema: 1`, and the engine did not stamp
   that field until 4.0.17, so 4.0.17 is the floor for BOTH scrapes: the compile
   one and the profile-lock one alike. Every release before it, which is every
   release a user's project is likely to already have, lands in the branch below.

   These are the tests to read before deleting lib/legacy-stdout.ts. The day the
   oldest engine worth supporting stamps schema:1, "an old contract" stops being
   reachable, the first two cases here become unreproducible, and the module and
   its exemption can go together. Until then a green run here is the evidence
   that removing them would silently downgrade a real diagnosis to "started
   fine". */
describe("the scrapes are still reachable, and only below the schema-1 floor", () => {
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

  /* @invariant The two contract fixtures sit either side of the floor, and this
     is what stops them drifting into each other. The pre-schema-1 one is not a
     hypothetical shape: it is what every release before 4.0.17 writes, and the
     probe must read it as "cannot carry the detail" rather than as "do not
     believe it". Adding schema:1 to it would make the case it exists to cover
     unreachable while every test that uses it stayed green. */
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

  /* @invariant The floor is a claim about the USER'S engine, not about the pin.
     The pin is comfortably above it, which is exactly why the pin cannot be the
     thing that retires the module: this server drives whatever
     node_modules/.bin/extension the project has. */
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
    const [major, minor, patch] = installed.split(".").map(Number);
    expect([major, minor, patch]).not.toContain(NaN);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(
      4 * 1_000_000 + 0 * 1_000 + 17,
    );
  });
});
