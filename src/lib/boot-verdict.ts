// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ReadyContract } from "./types";
import {
  LEGACY_FIDELITY_WARNING,
  denoiseCliLog,
  legacyCompileScrape,
  legacyProfileLockScrape,
} from "./legacy-stdout";

export interface ProfileLockOwner {
  host?: string;
  pid?: number;
}

// The engine's own stamp, from browsers-lib/ready-stamp.ts. Matched as a code,
// never as a sentence.
const PROFILE_LOCKED_CODE = "profile_locked";

export type BootVerdict =
  | { kind: "alive" }
  | { kind: "exited"; exitCode: number | null; signal: string | null }
  | { kind: "compile-failed"; message?: string; compileErrors: string[] }
  | {
      kind: "browser-exited";
      stamp: {
        code?: string;
        browserExitCode?: number | null;
        browserExitedAt?: string;
      };
    }
  | {
      kind: "profile-locked";
      owner: ProfileLockOwner | null;
      message?: string;
      lockedAt?: string;
    };

export interface BootReading {
  verdict: BootVerdict;
  /** The CLI stamped a schema-1 ready contract, so no prose was read. */
  machineContract: boolean;
  /** Denoised session-log tail, evidence of last resort. Never branched on. */
  output: string;
  warnings: string[];
}

export interface PollOptions {
  child: ChildProcess;
  readOutput: () => string;
  budgetMs: number;
  since: number;
  /** A build-only session never launches a browser, so it has no browser legs. */
  noBrowser?: boolean;
  intervalMs?: number;
}

export function readyContractPath(projectPath: string, browser: string): string {
  return path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );
}

interface ContractReading {
  contract: ReadyContract & Record<string, unknown>;
  fresh: boolean;
}

function readContract(
  projectPath: string,
  browser: string,
  since: number,
): ContractReading | null {
  try {
    const file = readyContractPath(projectPath, browser);
    const stat = fs.statSync(file);
    const contract = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!contract || typeof contract !== "object") return null;
    return { contract, fresh: stat.mtimeMs >= since };
  } catch {
    return null;
  }
}

// The capability probe. It asks the artefact what it speaks, never the pinned
// version: exec.ts prefers a project-local `.bin/extension` over the pin, so a
// user project on an older CLI wins and a semver gate would be a lie.
export function speaksMachineContract(contract: unknown): boolean {
  return (
    !!contract &&
    typeof contract === "object" &&
    (contract as { schema?: unknown }).schema === 1
  );
}

function profileLockOwner(
  contract: Record<string, unknown>,
): ProfileLockOwner | null {
  const owner = contract.profileLockOwner;
  if (!owner || typeof owner !== "object") return null;
  const { host, pid } = owner as ProfileLockOwner;
  return { ...(host ? { host } : {}), ...(pid != null ? { pid } : {}) };
}

function contractVerdict(
  reading: ContractReading,
  noBrowser: boolean,
): BootVerdict | null {
  const { contract, fresh } = reading;
  if (!fresh) return null;
  if (contract.status !== "error") return null;

  // The engine names the profile path, the holding pid and the host, which is
  // more than this side can reconstruct. Carry its sentence rather than ours.
  if (!noBrowser && contract.code === PROFILE_LOCKED_CODE) {
    return {
      kind: "profile-locked",
      owner: profileLockOwner(contract),
      message:
        typeof contract.message === "string" ? contract.message : undefined,
      lockedAt:
        typeof contract.profileLockedAt === "string"
          ? contract.profileLockedAt
          : undefined,
    };
  }

  const browserExited =
    contract.code === "browser_exited" ||
    contract.browserExitCode !== undefined ||
    contract.browserExitedAt !== undefined;
  if (!noBrowser && browserExited) {
    return {
      kind: "browser-exited",
      stamp: {
        code: contract.code,
        browserExitCode: contract.browserExitCode ?? null,
        browserExitedAt: contract.browserExitedAt,
      },
    };
  }

  return {
    kind: "compile-failed",
    message: contract.message,
    compileErrors: Array.isArray(contract.errors) ? contract.errors : [],
  };
}

/**
 * Poll the dev server's own contract for a boot verdict, and only fall back to
 * reading its output when the contract never lands. Replaces a blind sleep plus
 * a regex over first-party copy.
 */
export async function pollBootVerdict(
  projectPath: string,
  browser: string,
  options: PollOptions,
): Promise<BootReading> {
  const { child, readOutput, budgetMs, since } = options;
  const noBrowser = Boolean(options.noBrowser);
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + budgetMs;

  let contractSeen: ContractReading | null = null;

  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        verdict: {
          kind: "exited",
          exitCode: child.exitCode,
          signal: child.signalCode,
        },
        machineContract: speaksMachineContract(contractSeen?.contract),
        output: denoiseCliLog(readOutput()),
        warnings: [],
      };
    }

    contractSeen = readContract(projectPath, browser, since) ?? contractSeen;
    if (contractSeen) {
      const verdict = contractVerdict(contractSeen, noBrowser);
      if (verdict) {
        return {
          verdict,
          machineContract: speaksMachineContract(contractSeen.contract),
          output: denoiseCliLog(readOutput()),
          warnings: [],
        };
      }
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, Math.max(deadline - Date.now(), 1))),
    );
  }

  const machineContract = speaksMachineContract(contractSeen?.contract);
  const output = denoiseCliLog(readOutput());

  // The contract said nothing decisive within the budget. On a CLI that speaks
  // schema 1 that is the truth: the boot is fine so far. On an older one it may
  // only mean the stamp never came, so the deprecated scrapes get a turn.
  if (machineContract) {
    return { verdict: { kind: "alive" }, machineContract, output, warnings: [] };
  }

  if (legacyCompileScrape(output)) {
    return {
      verdict: { kind: "compile-failed", compileErrors: [] },
      machineContract,
      output,
      warnings: [LEGACY_FIDELITY_WARNING],
    };
  }

  if (!noBrowser && legacyProfileLockScrape(output)) {
    return {
      verdict: { kind: "profile-locked", owner: null },
      machineContract,
      output,
      warnings: [LEGACY_FIDELITY_WARNING],
    };
  }

  return { verdict: { kind: "alive" }, machineContract, output, warnings: [] };
}
