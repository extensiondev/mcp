import fs from "node:fs";
import path from "node:path";

import * as bridge from "extension-develop/bridge";

import { browserArtifactsDir, readyContractPath } from "../../lib/session-paths";
import { attachedDevContract, errorContract, readyContract } from "./engine-answers";

export function writeEvalToken(projectPath: string, browser: string): string {
  const file = bridge.controlTokenPath(projectPath, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "test-session-token", { mode: 0o600 });
  return file;
}

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
