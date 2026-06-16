import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// SECURITY: these spawns previously used `{ shell: true }`, which runs the
// command through `/bin/sh -c` (or cmd.exe) and concatenates the argv into one
// string. Tool inputs reach this layer untrusted (e.g. the `extension_eval`
// expression, project paths, URLs), so a value like `$(...)`, `;`, or backticks
// would be interpreted by the shell -> arbitrary command execution on the host
// running the MCP server (realistic via prompt-injection driving the client).
//
// We now spawn WITHOUT a shell via cross-spawn, which also resolves `npx` ->
// `npx.cmd` on Windows safely (plain child_process.spawn cannot run .cmd without
// a shell post-CVE-2024-27980). With no shell, every arg is passed verbatim as a
// single argv entry and shell metacharacters have no special meaning.

// Run `npx extension <args>` to completion and capture its output. Used by the
// one-shot act tools (eval/storage/reload/open), which wrap the CLI verb per the
// lockstep invariant "MCP tools shell out to the CLI verb" — the CLI is the
// single source of behavior; the MCP cannot drift from it.
export function runExtensionCli(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["extension", ...args], {
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

// Spawn `npx extension <args>` as a background process
// Used for dev/start/preview which require the full browser launcher
// infrastructure from programs/extension
export function spawnExtensionCli(
  args: string[],
  options?: { cwd?: string },
): ChildProcess {
  const child = spawn("npx", ["extension", ...args], {
    cwd: options?.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });

  child.unref();

  return child;
}
