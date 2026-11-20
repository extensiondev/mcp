// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import spawn from "cross-spawn";

import {
  describeEngineOverride,
  engineOverrideRefusal,
  resolveEngineOverride,
} from "./engine-override";
import { envelope } from "./envelope";
import { kernelProcessParents } from "./process-identity";

import { dependencies } from "../../package.json";

/* @invariant THE PROCESSES UNDER A PID ARE READ FROM THE KERNEL WHERE pgrep IS
 * MISSING. A slim container image ships neither pgrep nor ps, and there the
 * tree under an engine read as empty: a first build past its budget was
 * signalled in the middle of its install, only the top process was signalled
 * and the package manager under it lived on, and the next call ran a repair
 * beside it. Ledger 949 gave extension_stop and the start times a /proc
 * read and left this one out. pgrep that ran and found nothing is an empty
 * tree; pgrep that could not be started is answered from the parent field
 * of every /proc/<pid>/stat.
 */
function descendantsIn(parents: Map<number, number>, pid: number): number[] {
  const direct = [...parents].filter(([, parent]) => parent === pid).map(([child]) => child);

  return direct.flatMap((child) => [child, ...descendantsIn(parents, child)]);
}

export function descendantPids(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    const direct = out
      .split("\n")
      .map((line: string) => parseInt(line.trim(), 10))
      .filter((n: number) => Number.isInteger(n) && n > 0);

    return direct.flatMap((childPid: number) => [childPid, ...descendantPids(childPid)]);
  } catch (err) {
    const parents = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? kernelProcessParents() : null;

    return parents ? descendantsIn(parents, pid) : [];
  }
}

export function killWindowsTree(pid: number): boolean {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;

  if (process.platform === "win32") {
    killWindowsTree(pid);

    return;
  }

  for (const target of [...descendantPids(pid).reverse(), pid]) {
    try {
      process.kill(target, signal);
    } catch {
    }
  }
}

/* @invariant A CHILD'S OUTPUT IS READ FROM ITS END, UP TO A CAP. The output
 * goes to a file the child holds open, and the whole file was read into one
 * string when the child closed: a package manager or an engine that printed
 * without end cost the server that much memory, and past the string limit
 * the read threw and the answer carried no output at all. What an answer
 * uses is the end, the package manager's last lines or the engine's result
 * frame, so the read keeps the last bytes and drops the rest.
 */
const ENGINE_OUTPUT_CAP_BYTES = 32 * 1024 * 1024;
const INSTALL_OUTPUT_CAP_BYTES = 64 * 1024;

function readTail(file: string, capBytes: number): string {
  let fd: number | null = null;

  try {
    fd = fs.openSync(file, "r");

    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, capBytes);
    const buffer = Buffer.alloc(length);

    fs.readSync(fd, buffer, 0, length, size - length);

    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export interface CliResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  leftRunningPid?: number;
  stdout: string;
  stderr: string;
}

const KILL_HEADROOM_PAST_ENGINE_TIMEOUT_MS = 5_000;

const PINNED_CLI_VERSION = String(
  dependencies["extension-develop"] ?? "latest",
).replace(/^[\^~]/, "");

export function pinnedCliVersion(): string {
  const override = String(
    process.env.EXTENSION_MCP_CLI_VERSION || "",
  ).trim();

  return override || PINNED_CLI_VERSION;
}

export function exactVersion(spec: string): string {
  return spec.trim().replace(/^[\^~]/, "").replace(/^v/, "");
}

export function describeExtensionInvocation(projectDir?: string): string {
  const override = resolveEngineOverride();
  if (override) return describeEngineOverride(override);

  const { command, prefixArgs } = resolveExtensionInvocation(projectDir);

  return prefixArgs.length
    ? `${command} ${prefixArgs.join(" ")} (this server's pinned engine; the project has no node_modules/.bin/extension)`
    : `${command} (the project's own Extension.js)`;
}

export interface ExtensionInvocation {
  command: string;
  prefixArgs: string[];
  refusal?: string;
}

export function resolveExtensionInvocation(projectDir?: string): ExtensionInvocation {
  const override = resolveEngineOverride();

  if (override) {
    return override.bin
      ? { command: process.execPath, prefixArgs: [override.bin] }
      : { command: override.expectedBin, prefixArgs: [], refusal: engineOverrideRefusal(override) };
  }

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

export function engineRefusal(): string | null {
  return resolveExtensionInvocation().refusal ?? null;
}

/* @invariant A RUN THAT OUTLASTS ITS BUDGET WHILE IT INSTALLS DEPENDENCIES IS
 * LEFT RUNNING, NEVER KILLED HALFWAY. On 2026-11-18 (ledger 941) the kill
 * timer fired on a first build that was 180 s into npm install: the engine
 * died, the install either died with a half-written node_modules or lived on
 * as an orphan, and the next build ran against that folder and answered
 * "sh: 1: extension: not found". `leaveRunning` is asked once, when the
 * budget ends; when it answers true nothing is signalled, the call resolves
 * with timedOut and leftRunningPid, and the process finishes on its own with
 * its output still going to files it holds open. A run that is stopped gets
 * SIGTERM and, if it has not closed 5 s later, SIGKILL; once it has closed
 * that second signal is canceled, because its PID may by then belong to
 * another process.
 */
export function runExtensionCli(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; leaveRunning?: (pid: number) => boolean; onSpawn?: (pid: number) => void },
): Promise<CliResult> {
  const { command, prefixArgs, refusal } = resolveExtensionInvocation(options?.cwd);

  return new Promise((resolve, reject) => {
    if (refusal) {
      resolve({ code: 1, stdout: "", stderr: refusal });

      return;
    }

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

    const readAll = (name: string): string => readTail(path.join(ioDir, name), ENGINE_OUTPUT_CAP_BYTES);

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

    const budgetMs = (options?.timeoutMs ?? 30_000) + KILL_HEADROOM_PAST_ENGINE_TIMEOUT_MS;
    let child: ChildProcess;

    try {
      child = spawn(command, [...prefixArgs, ...args], {
        cwd: options?.cwd,
        stdio: ["ignore", outFd, errFd],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
    } catch (err) {
      cleanup();
      reject(err);

      return;
    }

    if (child.pid) options?.onSpawn?.(child.pid);

    let timedOut = false;
    let left = false;
    let killAgain: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;

      if (child.pid && options?.leaveRunning?.(child.pid)) {
        left = true;
        const stdout = readAll("stdout");
        const stderr = readAll("stderr");
        cleanup();
        child.unref();
        resolve({ code: null, signal: null, timedOut, leftRunningPid: child.pid, stdout, stderr });

        return;
      }

      killTree(child.pid, "SIGTERM");
      killAgain = setTimeout(() => killTree(child.pid, "SIGKILL"), KILL_HEADROOM_PAST_ENGINE_TIMEOUT_MS);
    }, budgetMs);
    child.on("close", (code, signal) => {
      if (left) return;

      clearTimeout(timer);
      clearTimeout(killAgain);
      const stdout = readAll("stdout");
      const stderr = readAll("stderr");
      cleanup();
      resolve({ code: timedOut ? null : code, signal, timedOut, stdout, stderr });
    });

    child.on("error", (err) => {
      if (left) return;

      const stdout = readAll("stdout");
      const stderr = readAll("stderr");
      cleanup();
      resolve({ code: 1, stdout, stderr: stderr || String(err) });
    });
  });
}

export interface PackageInstallResult {
  code: number | null;
  timedOut: boolean;
  leftRunningPid?: number;
  notFound?: boolean;
  output: string;
}

const WINDOWS_COMMAND_NOT_FOUND = /is not recognized as an internal or external command/;

export function runPackageInstall(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; onSpawn?: (pid: number) => void },
): Promise<PackageInstallResult> {
  return new Promise((resolve) => {
    let ioDir: string;
    let fd: number;

    try {
      ioDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-mcp-install-"));
      fd = fs.openSync(path.join(ioDir, "output"), "a");
    } catch (err) {
      resolve({ code: 1, timedOut: false, output: String(err) });

      return;
    }

    const finish = (result: Omit<PackageInstallResult, "output">, fallback = ""): void => {
      const output = readTail(path.join(ioDir, "output"), INSTALL_OUTPUT_CAP_BYTES) || fallback;

      try {
        fs.closeSync(fd);
      } catch {
      }

      fs.rmSync(ioDir, { recursive: true, force: true });
      resolve({ ...result, ...(result.code !== 0 && WINDOWS_COMMAND_NOT_FOUND.test(output) ? { notFound: true } : {}), output });
    };

    let child: ChildProcess;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch (err) {
      finish({ code: 1, timedOut: false }, String(err));

      return;
    }

    if (child.pid) options.onSpawn?.(child.pid);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled || !child.pid) return;

      settled = true;
      child.unref();
      finish({ code: null, timedOut: true, leftRunningPid: child.pid });
    }, options.timeoutMs);

    child.on("close", (code) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      finish({ code, timedOut: false });
    });

    child.on("error", (err) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      finish({ code: 1, timedOut: false, ...((err as NodeJS.ErrnoException).code === "ENOENT" ? { notFound: true } : {}) }, String(err));
    });
  });
}

/* @invariant A PROCESS THE OPERATING SYSTEM REFUSES TO START FOR ITS
 * ARGUMENTS IS THE CALLER'S INPUT, NEVER A TRANSIENT FAILURE. Node throws
 * these from spawn before any child exists: ENAMETOOLONG for a working
 * directory or a path past the system's limit, E2BIG for an argument list
 * past it, EINVAL for an argument the system cannot pass, and a TypeError for
 * a NUL byte. The same call fails the same way every time, so the dispatcher
 * answers E_INPUT_VALIDATION with retry "no" (ledger 908); as E_INTERNAL
 * they read retry "safe" and an agent looped on them. ENAMETOOLONG is an
 * over-long name whatever the system call; the other two count only from
 * spawn, where an argument is the one cause.
 */
export function argumentFailure(err: unknown): string | null {
  if (!(err instanceof Error)) return null;

  const { code, syscall } = err as NodeJS.ErrnoException;
  const fromSpawn = typeof syscall === "string" && syscall.startsWith("spawn");
  const refused =
    code === "ENAMETOOLONG" ||
    (fromSpawn && (code === "E2BIG" || code === "EINVAL")) ||
    (code === "ERR_INVALID_ARG_VALUE" && err.message.includes("null bytes"));

  return refused ? err.message : null;
}

export interface SpawnedCli {
  child: ChildProcess;
  logPath: string;
  readOutput: () => string;
  spawnError?: () => Error | null;
}

export function spawnExtensionCli(
  args: string[],
  options?: { cwd?: string; projectDir?: string; env?: Record<string, string> },
): SpawnedCli {
  const { command, prefixArgs, refusal } = resolveExtensionInvocation(
    options?.projectDir ?? options?.cwd,
  );
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-mcp-"));
  const logPath = path.join(logDir, "session.log");
  const fd = fs.openSync(logPath, "a");

  const readOutput = () => {
    try {
      return fs.readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
  };

  if (refusal) {
    fs.writeSync(fd, `${refusal}\n`);
    fs.closeSync(fd);
    const failure = new Error(refusal);

    return {
      child: new ChildProcess(),
      logPath,
      readOutput,
      spawnError: () => failure,
    };
  }

  let child: ChildProcess;

  try {
    child = spawn(command, [...prefixArgs, ...args], {
      cwd: options?.cwd ?? options?.projectDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...options?.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(logDir, { recursive: true, force: true });

    throw err;
  }

  fs.closeSync(fd);

  let spawnFailure: Error | null = null;
  child.on("error", (err) => {
    spawnFailure ??= err;
  });

  child.unref();

  return {
    child,
    logPath,
    readOutput,
    spawnError: () => spawnFailure,
  };
}

export async function spawnFailedEnvelope(
  command: string,
  spawned: SpawnedCli,
): Promise<string> {
  const deadline = Date.now() + 500;
  const handVerb = command === "extension_start" ? "start" : "dev";
  let cause = spawned.spawnError?.() ?? null;

  while (!cause && Date.now() < deadline) {
    await sleep(25);
    cause = spawned.spawnError?.() ?? null;
  }

  return envelope({
    ok: false,
    command,
    status: "spawn-failed",
    error: {
      code: "E_CLI",
      name: "CliError",
      message: `The extension CLI process could not be spawned${cause ? ` (${cause.message})` : ""}. No session was started and nothing was registered.`,
    },
    hint: `The one command this server chose could not be launched: the engine override when EXTENSION_MCP_ENGINE_DIR is set, else the project-local node_modules/.bin/extension when the project has one, else npx. Fix or unset the override, install the engine in the project (npm i -D extension) or put npx on the PATH the MCP server runs with, then call the tool again. Or run the session by hand: the project's own \`npx extension ${handVerb} --browser <b> --allow-control\` (add --allow-eval for extension_eval) writes the same dist/extension-js/<browser>/ready.json contract, and extension_logs, extension_open and extension_eval then work on it.`,
  });
}
