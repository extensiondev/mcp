import fs from "node:fs";
import path from "node:path";

function contractDir(projectPath: string, browser: string): string {
  return path.join(projectPath, "dist", "extension-js", browser);
}

function writeContract(
  projectPath: string,
  browser: string,
  contract: Record<string, unknown>,
): string {
  const dir = contractDir(projectPath, browser);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ready.json");
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

// A CLI that carries the machine contract stamps `schema: 1`, which is what the
// MCP probes for before it trusts the contract over the dev server's output.
export function writeMachineContractError(
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

// What the shipped engine writes today: the ready contract's own schemaVersion,
// with no `schema: 1` machine-contract declaration. Its error stamps are still
// authoritative, so a verdict must never be gated on the capability probe.
export function writeStampedContractError(
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
    contractDir(projectPath, browser),
    "control-port",
  );
  fs.mkdirSync(path.dirname(legacyPortFile), { recursive: true });
  fs.writeFileSync(legacyPortFile, "43210\n");

  const legacyTokenFile = path.join(projectPath, ".extension-js", "control.token");
  fs.mkdirSync(path.dirname(legacyTokenFile), { recursive: true });
  fs.writeFileSync(legacyTokenFile, "a".repeat(64));

  return { legacyPortFile, legacyTokenFile };
}
