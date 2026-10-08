// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveExtensionInvocation, runExtensionCli } from "./exec";

export const OUTPUT_JSON_FLOOR = {
  act: "3.18.1",
  doctor: "4.0.11",
  dev: "4.0.17",
  build: "4.0.17",
} as const;

export type OutputJsonCommand = keyof typeof OUTPUT_JSON_FLOOR;

const VERDICT_TTL_MS_SHORTER_THAN_AN_UPGRADE_LONGER_THAN_A_BURST = 60_000;

const PROBE_TIMEOUT_MS_READ_AS_UNKNOWN_ON_EXPIRY = 20_000;

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface VersionParts {
  release: number[];
  prerelease: string[];
}

function decompose(version: string): VersionParts | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;

  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function parseVersion(text: string): string | null {
  for (const line of text.split("\n")) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (decompose(candidate)) return candidate.replace(/^v/, "");
  }

  return null;
}

function compareNumericIdentifiers(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;

  return left < right ? -1 : 1;
}

export function compareVersions(a: string, b: string): number | null {
  const left = decompose(a);
  const right = decompose(b);
  if (!left || !right) return null;

  for (let i = 0; i < 3; i += 1) {
    if (left.release[i] !== right.release[i]) {
      return left.release[i] < right.release[i] ? -1 : 1;
    }
  }

  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let i = 0; i < length; i += 1) {
    const one = left.prerelease[i];
    const other = right.prerelease[i];
    if (one === undefined) return -1;
    if (other === undefined) return 1;

    const oneIsNumeric = /^\d+$/.test(one);
    const otherIsNumeric = /^\d+$/.test(other);

    if (oneIsNumeric && otherIsNumeric) {
      const ordering = compareNumericIdentifiers(one, other);
      if (ordering !== 0) return ordering;

      continue;
    }

    if (oneIsNumeric !== otherIsNumeric) return oneIsNumeric ? -1 : 1;
    if (one !== other) return one < other ? -1 : 1;
  }

  return 0;
}

export interface EngineFacts {
  version: string | null;
  outputJsonCommands: readonly string[] | null;
}

interface CachedFacts extends EngineFacts {
  expiresAt: number;
}

const verdicts = new Map<string, CachedFacts>();

export function resetEngineVersionCache(): void {
  verdicts.clear();
}

function invocationKey(command: string, prefixArgs: string[]): string {
  return [command, ...prefixArgs].join("\0");
}

const NPX_PIN = /^extension@(.+)$/;

function parseCapabilities(stdout: string): EngineFacts | null {
  for (const line of stdout.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;

    let frame: unknown;

    try {
      frame = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!frame || typeof frame !== "object") continue;

    const envelope = frame as {
      schema?: unknown;
      ok?: unknown;
      command?: unknown;
      value?: unknown;
    };
    if (envelope.schema !== 1) continue;
    if (envelope.ok !== true) continue;
    if (envelope.command !== "capabilities") continue;

    const value = envelope.value as {
      version?: unknown;
      outputJsonCommands?: unknown;
    } | null;
    if (!value || typeof value !== "object") continue;

    const version =
      typeof value.version === "string" ? parseVersion(value.version) : null;
    const roster = value.outputJsonCommands;
    if (!version || !Array.isArray(roster)) continue;
    if (!roster.every((name) => typeof name === "string")) continue;

    return { version, outputJsonCommands: roster };
  }

  return null;
}

export async function resolvedEngineFacts(
  projectPath?: string,
): Promise<EngineFacts> {
  const { command, prefixArgs } = resolveExtensionInvocation(projectPath);
  const key = invocationKey(command, prefixArgs);
  const cached = verdicts.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      version: cached.version,
      outputJsonCommands: cached.outputJsonCommands,
    };
  }

  const remember = (found: EngineFacts): EngineFacts => {
    verdicts.set(key, { ...found, expiresAt: Date.now() + VERDICT_TTL_MS_SHORTER_THAN_AN_UPGRADE_LONGER_THAN_A_BURST });

    return found;
  };

  for (const arg of prefixArgs) {
    const pin = NPX_PIN.exec(arg);
    const pinned = pin ? parseVersion(pin[1]) : null;
    if (pinned) return remember({ version: pinned, outputJsonCommands: null });
  }

  try {
    const probe = await runExtensionCli(["capabilities"], {
      cwd: projectPath,
      timeoutMs: PROBE_TIMEOUT_MS_READ_AS_UNKNOWN_ON_EXPIRY,
    });

    if (probe.code === 0) {
      const answered = parseCapabilities(probe.stdout ?? "");
      if (answered) return remember(answered);
    }
  } catch {
  }

  try {
    const probe = await runExtensionCli(["--version"], {
      cwd: projectPath,
      timeoutMs: PROBE_TIMEOUT_MS_READ_AS_UNKNOWN_ON_EXPIRY,
    });

    if (probe.code !== 0) {
      return remember({ version: null, outputJsonCommands: null });
    }

    return remember({
      version:
        parseVersion(probe.stdout ?? "") ?? parseVersion(probe.stderr ?? ""),
      outputJsonCommands: null,
    });
  } catch {
    return remember({ version: null, outputJsonCommands: null });
  }
}

export async function resolvedEngineVersion(
  projectPath?: string,
): Promise<string | null> {
  return (await resolvedEngineFacts(projectPath)).version;
}

export interface OutputJsonVerdict {
  supported: boolean | null;
  version: string | null;
  floor: string;
}

const ROSTER_NAMES: Record<OutputJsonCommand, readonly string[]> = {
  act: ["eval", "inspect", "open", "reload", "storage"],
  doctor: ["doctor"],
  dev: ["dev"],
  build: ["build"],
} as const;

export async function outputJsonVerdict(
  command: OutputJsonCommand,
  projectPath?: string,
): Promise<OutputJsonVerdict> {
  const floor = OUTPUT_JSON_FLOOR[command];
  let engine: EngineFacts;

  try {
    engine = await resolvedEngineFacts(projectPath);
  } catch {
    return { supported: null, version: null, floor };
  }

  const roster = engine.outputJsonCommands;

  if (roster) {
    return {
      supported: ROSTER_NAMES[command].every((name) => roster.includes(name)),
      version: engine.version,
      floor,
    };
  }

  const version = engine.version;
  if (version === null) return { supported: null, version: null, floor };

  const ordering = compareVersions(version, floor);
  if (ordering === null) return { supported: null, version, floor };

  return { supported: ordering >= 0, version, floor };
}

const UNKNOWN_OUTPUT_FLAG_EITHER_PHRASING = /unknown option[^\n]*--output\b/i;

export function refusedTheOutputFlag(stderr: string): boolean {
  return UNKNOWN_OUTPUT_FLAG_EITHER_PHRASING.test(stderr);
}

export async function outputFlagRefusalMessage(
  command: OutputJsonCommand,
  cliName: string,
  projectPath?: string,
): Promise<string> {
  const verdict = await outputJsonVerdict(command, projectPath);
  const preamble = `The Extension.js resolved for this project refused \`--output json\` on \`extension ${cliName}\`.`;
  const why =
    "You did not pass that flag: this server adds it so it can read a structured result instead of parsing a report written for a human, and unlike `build` there is no second source it can fall back to here, so it cannot simply drop it.";

  if (verdict.supported === false) {
    return `${preamble} It reports ${verdict.version}, and that flag only reached \`extension ${cliName}\` in ${verdict.floor}. ${why} Upgrade the project's Extension.js to ${verdict.floor} or newer and run this again.`;
  }

  if (verdict.supported === true) {
    return `${preamble} It reports ${verdict.version}, which is at or above ${verdict.floor}, the release where that flag reached \`extension ${cliName}\`, so the binary being run is not the version it claims to be. ${why} Check the project's node_modules/.bin/extension and reinstall it, rather than upgrading a version that already looks new enough.`;
  }

  return `${preamble} Its version could not be read, so the cause cannot be confirmed, but that flag only reached \`extension ${cliName}\` in ${verdict.floor} and a refusal is what an engine below that does. ${why} Check the project's Extension.js install and bring it to ${verdict.floor} or newer.`;
}
