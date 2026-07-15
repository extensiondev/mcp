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

// The `extension` CLI version this MCP release is verified against. Derived
// from the vendored extension-develop dependency so the two can never drift:
// bumping the library in package.json automatically re-pins the CLI spawns.
const PINNED_CLI_VERSION = String(
  dependencies["extension-develop"] ?? "latest",
).replace(/^[\^~]/, "");

// EXTENSION_MCP_CLI_VERSION overrides the vendored pin. This is the harness
// escape hatch for validating an unreleased engine (e.g. the latest canary)
// through the same MCP surface real agents use; a project-local CLI still
// wins per the lockstep invariant.
function pinnedCliVersion(): string {
  const override = String(
    process.env.EXTENSION_MCP_CLI_VERSION || "",
  ).trim();
  return override || PINNED_CLI_VERSION;
}

/**
 * Resolve how to invoke the `extension` CLI for a given project.
 *
 * Preference order:
 * 1. The project's own `node_modules/.bin/extension` — the version the project
 *    pinned is the single source of behavior for that project (lockstep
 *    invariant), and spawning it needs no network.
 * 2. `npx extension@<pinned>` — pinned to the extension-develop version this
 *    package vendors, never a floating `latest`, so MCP behavior stays
 *    reproducible even without a project-local install.
 */
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
      // no project-local CLI — fall through to the pinned npx path
    }
  }
  return { command: "npx", prefixArgs: [`extension@${pinnedCliVersion()}`] };
}

// Run `extension <args>` to completion and capture its output. Used by the
// one-shot act tools (eval/storage/reload/open), which wrap the CLI verb per the
// lockstep invariant "MCP tools shell out to the CLI verb" — the CLI is the
// single source of behavior; the MCP cannot drift from it.
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

// Spawn `extension <args>` as a detached background process. Used for
// dev/start/preview which require the full browser launcher infrastructure
// from programs/extension. Detached => the child leads its own process group,
// which is what lets extension_stop terminate the whole tree (dev server +
// launched browser) with one group signal.
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
