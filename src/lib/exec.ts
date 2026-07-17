import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import spawn from "cross-spawn";
import { dependencies } from "../../package.json";

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const PINNED_CLI_VERSION = String(
  dependencies["extension-develop"] ?? "latest",
).replace(/^[\^~]/, "");

function pinnedCliVersion(): string {
  const override = String(
    process.env.EXTENSION_MCP_CLI_VERSION || "",
  ).trim();
  return override || PINNED_CLI_VERSION;
}

export function resolveExtensionInvocation(projectDir?: string): {
  command: string;
  prefixArgs: string[];
} {
  if (projectDir) {
    const bin = path.join(
      projectDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "extension.cmd" : "extension",
    );
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return { command: bin, prefixArgs: [] };
    } catch {
    }
  }
  return { command: "npx", prefixArgs: [`extension@${pinnedCliVersion()}`] };
}

export function runExtensionCli(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CliResult> {
  const { command, prefixArgs } = resolveExtensionInvocation(options?.cwd);
  return new Promise((resolve) => {
    const child = spawn(command, [...prefixArgs, ...args], {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout: options?.timeoutMs ?? 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: stderr || String(err) }),
    );
  });
}

export function spawnExtensionCli(
  args: string[],
  options?: { cwd?: string; projectDir?: string },
): ChildProcess {
  const { command, prefixArgs } = resolveExtensionInvocation(
    options?.projectDir ?? options?.cwd,
  );
  const child = spawn(command, [...prefixArgs, ...args], {
    cwd: options?.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });

  child.unref();

  return child;
}
