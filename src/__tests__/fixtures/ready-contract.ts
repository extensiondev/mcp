import fs from "node:fs";
import path from "node:path";

import { browserArtifactsDir, readyContractPath } from "../../lib/session-paths";

/* @invariant These fixtures go through the same owner module the production
   readers use, so a layout change in the engine moves the code and its fixtures
   together. Building dist/extension-js/<browser>/ready.json by hand here would
   survive such a change and keep every suite green while writing files no reader
   could find, which is the one failure the single-owner guard exists to prevent
   and the one it cannot see, because it does not scan __tests__. */
function writeContract(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown>,
): string {
  const file = readyContractPath(projectPath, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contract, null, 2));
  return file;
}

export function writeModernContract(
  projectPath: string,
  browser: string,
  overrides: Record<string, unknown> = {},
): string {
  return writeContract(projectPath, browser, {
    schemaVersion: 2,
    status: "ready",
    browser,
    instanceId: "inst-modern",
    runId: "run-modern",
    controlPort: 43210,
    port: 8080,
    pid: process.pid,
    cdpPort: 9333,
    ...overrides,
  });
}

export function writeLegacyContract(
  projectPath: string,
  browser: string,
  overrides: Record<string, unknown> = {},
): string {
  return writeContract(projectPath, browser, {
    schemaVersion: 2,
    status: "ready",
    browser,
    instanceId: "inst-legacy",
    runId: "run-legacy",
    controlPort: 43210,
    port: 8080,
    ...overrides,
  });
}

export function writeErrorContract(
  projectPath: string,
  browser: string,
): string {
  return writeContract(projectPath, browser, {
    schemaVersion: 2,
    status: "error",
    browser,
    instanceId: "inst-err",
    controlPort: 43210,
    message: "compile failed",
  });
}

export function writeSchema1ContractError(
  projectPath: string,
  browser: string,
  overrides: Record<string, unknown> = {},
): string {
  return writeContract(projectPath, browser, {
    schema: 1,
    schemaVersion: 2,
    status: "error",
    browser,
    instanceId: "inst-machine",
    controlPort: 43210,
    ...overrides,
  });
}

/* @invariant An engine BELOW 4.0.17: the ready contract's own schemaVersion,
   with no `schema: 1` machine-contract declaration. This used to say "what the
   shipped engine writes today", which stopped being true the moment 4.0.17
   added the stamp, and the name that went with it (writeShippedEngineContract-
   Error) then read as the current shape rather than the old one.

   The fixture is worth more than the wrong label was. Every release before
   4.0.17 is still an ordinary thing for a user's project to have, and this is
   the shape those sessions write. What it pins is that such a contract's error
   stamps are authoritative on their own: a verdict must never be gated on the
   capability probe, because the probe is about how much detail the contract can
   carry, not about whether to believe it. */
export function writePreSchema1ContractError(
  projectPath: string,
  browser: string,
  overrides: Record<string, unknown> = {},
): string {
  return writeContract(projectPath, browser, {
    schemaVersion: 2,
    status: "error",
    browser,
    instanceId: "inst-stamped",
    controlPort: 43210,
    ...overrides,
  });
}

export function writeLegacyEngineState(
  projectPath: string,
  browser: string,
): { legacyPortFile: string; legacyTokenFile: string } {
  /* @invariant The file NAMES here are deliberately literal: these are the slots
     an OLD engine wrote, so they must not move when the current layout does. The
     directory still comes from the owner module, because the legacy slots sat
     inside the same per-browser artifacts dir the engine still uses. */
  const legacyPortFile = path.join(
    browserArtifactsDir(projectPath, browser),
    "control-port",
  );
  fs.mkdirSync(path.dirname(legacyPortFile), { recursive: true });
  fs.writeFileSync(legacyPortFile, "43210\n");

  const legacyTokenFile = path.join(projectPath, ".extension-js", "control.token");
  fs.mkdirSync(path.dirname(legacyTokenFile), { recursive: true });
  fs.writeFileSync(legacyTokenFile, "a".repeat(64));

  return { legacyPortFile, legacyTokenFile };
}
