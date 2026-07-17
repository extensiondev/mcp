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
