import fs from "node:fs";
import path from "node:path";

/**
 * ready.json shape builders across engine generations. The MCP must keep
 * working against contracts written by OLDER extension.js versions — a
 * 4.0.6-era session writes no cdpPort and no pid, and users run old CLIs
 * under new MCPs all the time (the version-skew CI matrix pins the engine;
 * these fixtures pin the contract SHAPES those engines wrote).
 */

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

/** Current-generation contract: pid, cdpPort, controlPort all stamped. */
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

/** 4.0.6-era contract: status/ports/instanceId only — NO cdpPort, NO pid. */
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

/**
 * Old-generation SESSION-STATE files the engine (not the MCP) reads:
 * the pre-#484 control-port slot under dist/ and the shared control.token.
 * The MCP deliberately ignores both — these exist so any future MCP feature
 * that starts reading them gets a fixture to extend instead of inventing
 * shapes.
 */
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
