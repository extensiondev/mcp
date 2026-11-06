// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { resolveEngineOverride } from "./engine-override";

interface OverrideMemo {
  env: string;
  given: string;
  bin: string | null;
}

let memo: OverrideMemo | null = null;

function stillAFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readOverride(env: NodeJS.ProcessEnv): OverrideMemo | null {
  if (memo && memo.bin && env[memo.env] === memo.given && stillAFile(memo.bin)) return memo;

  const override = resolveEngineOverride(env);
  memo = override ? { env: override.env, given: override.given, bin: override.bin } : null;

  return memo;
}

export function deadEngineOverrideLine(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = readOverride(env);
  if (!override || override.bin) return null;

  return `${override.env}=${override.given} names no engine bin; fix or unset it before extension_dev, extension_build or extension_start`;
}

export function deadEngineOverrideInstruction(env: NodeJS.ProcessEnv = process.env): string | null {
  const line = deadEngineOverrideLine(env);
  if (!line) return null;

  return `This server started while ${line}; every answer carries that line in warnings until the path holds an engine or the variable is unset, and extension_doctor shows the paths it expects.`;
}
