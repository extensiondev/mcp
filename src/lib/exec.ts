// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
    let ioDir: string;
    let outFd: number;
    let errFd: number;
    try {
      ioDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-mcp-io-"));
      outFd = fs.openSync(path.join(ioDir, "stdout"), "a");
      errFd = fs.openSync(path.join(ioDir, "stderr"), "a");
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: String(err) });
      return;
    }
    const readAll = (name: string): string => {
      try {
        return fs.readFileSync(path.join(ioDir, name), "utf8");
      } catch {
        return "";
      }
    };
    const cleanup = () => {
      for (const fd of [outFd, errFd]) {
        try {
          fs.closeSync(fd);
        } catch {
        }
      }
      try {
        fs.rmSync(ioDir, { recursive: true, force: true });
      } catch {
      }
    };
    const child = spawn(command, [...prefixArgs, ...args], {
      cwd: options?.cwd,
      stdio: ["ignore", outFd, errFd],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout: options?.timeoutMs ?? 30_000,
    });
    child.on("close", (code) => {
      const stdout = readAll("stdout");
      const stderr = readAll("stderr");
      cleanup();
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      const stdout = readAll("stdout");
      const stderr = readAll("stderr");
      cleanup();
      resolve({ code: 1, stdout, stderr: stderr || String(err) });
    });
  });
}

export interface SpawnedCli {
  child: ChildProcess;
  logPath: string;
  readOutput: () => string;
}

export function spawnExtensionCli(
  args: string[],
  options?: { cwd?: string; projectDir?: string },
): SpawnedCli {
  const { command, prefixArgs } = resolveExtensionInvocation(
    options?.projectDir ?? options?.cwd,
  );
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-mcp-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(command, [...prefixArgs, ...args], {
    cwd: options?.cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  fs.closeSync(fd);

  child.unref();

  return {
    child,
    logPath,
    readOutput: () => {
      try {
        return fs.readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}
