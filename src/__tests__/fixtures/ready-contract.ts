import fs from "node:fs";
import path from "node:path";

import * as bridge from "extension-develop/bridge";

import { browserArtifactsDir, readyContractPath } from "../../lib/session-paths";
import { attachedDevContract, errorContract, readyContract } from "./engine-answers";

/* @invariant A session fixture that wants eval writes the engine's own token
   file, at the path the engine publishes, the way `extension dev --allow-eval`
   does. A fixture that only says "ready" models a session started WITHOUT
   allowEval, and every eval route refuses it; the suites that evaluate over
   the debug port used to pass on such sessions, which is how the gate went
   unenforced there. */
export function writeEvalToken(projectPath: string, browser: string): string {
  const file = bridge.controlTokenPath(projectPath, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "test-session-token", { mode: 0o600 });
  return file;
}

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

/* @invariant A "modern" contract is the one the pinned engine writes: the
   full `readyContract("dev")` base with the launcher's stamps, `schema: 1`
   included. The hand-written shape this used to be (status, pid, ports and
   nothing else) let every dev and start cell skip the machine-contract branch
   of the boot verdict and never carried the fields wait and assert read
  . */
export function writeModernContract(
  projectPath: string,
  browser: string,
  overrides: Record<string, unknown> = {},
): string {
  return writeContract(
    projectPath,
    browser,
    attachedDevContract(browser, {
      instanceId: "inst-modern",
      runId: "run-modern",
      distPath: path.join(projectPath, "dist", browser),
      manifestPath: path.join(projectPath, "src", "manifest.json"),
      logsPath: path.join(browserArtifactsDir(projectPath, browser), "logs.ndjson"),
      ...overrides,
    }),
  );
}

/* The contract after the compile landed and before any browser stamped it:
   what a `noBrowser` session keeps for good, and what a launching session
   shows for a moment. The base only, no launcher or executor fields. */
export function writeCompiledUnattachedContract(
  projectPath: string,
  browser: string,
  overrides: Record<string, unknown> = {},
): string {
  return writeContract(
    projectPath,
    browser,
    readyContract("dev", browser, {
      instanceId: "inst-unattached",
      runId: "run-unattached",
      distPath: path.join(projectPath, "dist", browser),
      manifestPath: path.join(projectPath, "src", "manifest.json"),
      logsPath: path.join(browserArtifactsDir(projectPath, browser), "logs.ndjson"),
      ...overrides,
    }),
  );
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
  return writeContract(
    projectPath,
    browser,
    errorContract(browser, "compile_error", {
      instanceId: "inst-err",
      distPath: path.join(projectPath, "dist", browser),
    }),
  );
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
