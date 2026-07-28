// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveExtensionInvocation, runExtensionCli } from "./exec";

/* @invariant
 * The floor for each command is the release that first accepted --output json,
 * read off the engine's own history rather than assumed from the pin this
 * package carries. `doctor` got the flag in 4.0.11, and `dev` and `build` only
 * in 4.0.17. They are listed together because a single table is the honest
 * record of what was verified; only the entry a caller asks for is ever
 * consulted, so listing a floor here does not put the flag in front of any
 * command that is not already sending it.
 *
 * The `act` entry is the one number here that is NOT the release it claims to
 * be. `programs/extension/commands/act.ts` does not exist before 3.18.0 and
 * already registers `--output <pretty|json>` in that first release, so the true
 * floor is 3.18.0 and the 3.18.1 below is one patch high. It is left alone
 * rather than quietly corrected because the error is conservative in the only
 * direction that matters: too high means a 3.18.0 engine is judged "too old",
 * and the act family never acts on that verdict except to explain a refusal
 * that a 3.18.0 engine will not produce, since it accepts the flag. Moving it
 * is a behaviour change and wants its own commit, not a comment sweep.
 */
export const OUTPUT_JSON_FLOOR = {
  act: "3.18.1",
  doctor: "4.0.11",
  dev: "4.0.17",
  build: "4.0.17",
} as const;

export type OutputJsonCommand = keyof typeof OUTPUT_JSON_FLOOR;

/* @invariant
 * One minute, and the number is a judgement about which way to be wrong.
 *
 * This server can run for days, so a verdict cached forever would outlive a
 * user upgrading their engine mid-session and keep answering with the version
 * they replaced. No cache at all is also wrong for a different reason: an agent
 * that builds chrome, firefox and edge back to back would pay three probes for
 * one answer.
 *
 * A minute takes both. It is shorter than any realistic upgrade-then-build
 * cycle, so an upgrade is honoured almost immediately, and it still collapses a
 * burst of builds onto a single probe. The worst case is bounded on both sides
 * and neither side breaks a build: a stale "too old" costs the richer inline
 * report for up to a minute, and a stale "new enough" costs exactly the double
 * build the retry already handles. The probe itself is one non-compiling exec
 * against a local binary, which is nothing next to the compile it protects.
 */
const VERDICT_TTL_MS = 60_000;

/* @invariant
 * The probe must never become the slow part. A local node_modules/.bin exec
 * answers in tens of milliseconds; the only path that can be slow is the npx
 * fallback with an unpinned spec, which has to fetch before it can answer. The
 * ceiling is generous enough for that fetch and still short enough that a
 * wedged binary cannot hold a build hostage, because a timeout here is read as
 * "unknown" and the build proceeds exactly as it did before this probe existed.
 */
const PROBE_TIMEOUT_MS = 20_000;

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

/* @invariant
 * A version is only accepted from a line that is nothing but a version.
 *
 * `extension --version` prints the bare string, but the same stream also
 * carries the Node guard's refusal, which names a Node version of its own.
 * Scanning for the first version-shaped substring anywhere in the output would
 * happily read that guard's number and decide the engine is ancient. Matching
 * whole lines means unfamiliar output yields null, which is the answer that
 * falls back to the flag and the retry rather than the answer that silently
 * downgrades a modern engine.
 */
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

/* @invariant
 * Semver precedence, not string order and not a numeric triple.
 *
 * The versions this server meets include canaries such as
 * 4.0.19-canary.1785200797.ce99a79e, and every naive shortcut gets one of them
 * wrong: string compare puts 4.0.9 above 4.0.17, and comparing only the triple
 * calls 4.0.17-canary.1 an equal of 4.0.17 when it precedes it. So the rule is
 * the spec's: the release triple decides first, a version with a prerelease
 * ranks below the same triple without one, and prereleases are compared
 * identifier by identifier with numeric identifiers ordered numerically and
 * ranked below alphanumeric ones. Numeric identifiers are compared by digit
 * count then lexically rather than through Number, so a timestamp identifier
 * long enough to lose precision as a double still orders exactly.
 *
 * Ranking 4.0.17-canary.N below the 4.0.17 floor is deliberate even though the
 * flag landed before that tag was cut. It is the reading the spec gives and the
 * one the ecosystem expects, and the cost of the conservative answer is only
 * the optimisation: such a canary is sent the flag, accepts it, and nothing is
 * paid twice.
 */
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

interface CachedVerdict {
  version: string | null;
  expiresAt: number;
}

const verdicts = new Map<string, CachedVerdict>();

export function resetEngineVersionCache(): void {
  verdicts.clear();
}

/* @invariant
 * The cache is keyed on the invocation, never on the project.
 *
 * resolveExtensionInvocation reads the user's own node_modules/.bin, so two
 * projects on one machine can be on different engines and a project-keyed cache
 * would answer for one of them with the other's version. Keying on the command
 * and its prefix arguments is the truthful key: every project that resolves to
 * the same binary shares one answer, which is what makes a monorepo of packages
 * pay a single probe, and a project that resolves anywhere else gets its own.
 */
/* @invariant
 * The separator is written as an escape, never as a raw NUL byte.
 *
 * A NUL cannot appear in a command path or an argument, which is what makes it
 * the right separator here. Typing the byte itself into the source is a
 * different matter: git then classifies the whole file as binary and shows no
 * diff for any change to it, so every later edit arrives unreviewable. This
 * repository has already been bitten once, in the artifact store, where a
 * formatter pass silently replaced raw separators with empty strings and every
 * test still passed because nothing could see what changed. An escape carries
 * the same byte at runtime and stays legible to humans and tools.
 */
function invocationKey(command: string, prefixArgs: string[]): string {
  return [command, ...prefixArgs].join("\0");
}

const NPX_PIN = /^extension@(.+)$/;

/* @invariant
 * The npx fallback answers without spawning anything.
 *
 * When no project-local binary exists the invocation is `npx extension@<spec>`
 * with the spec this package pins, so the version that will run is already
 * written in the arguments about to be passed. Reading it out of the argument
 * rather than off a probe is both free and more truthful than a second source
 * would be. A spec that is not an exact version, such as `latest` or an
 * operator override, parses to null and falls through to a real probe.
 */
export async function resolvedEngineVersion(
  projectPath?: string,
): Promise<string | null> {
  const { command, prefixArgs } = resolveExtensionInvocation(projectPath);
  const key = invocationKey(command, prefixArgs);
  const cached = verdicts.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.version;

  const remember = (version: string | null): string | null => {
    verdicts.set(key, { version, expiresAt: Date.now() + VERDICT_TTL_MS });
    return version;
  };

  for (const arg of prefixArgs) {
    const pin = NPX_PIN.exec(arg);
    const pinned = pin ? parseVersion(pin[1]) : null;
    if (pinned) return remember(pinned);
  }

  try {
    const probe = await runExtensionCli(["--version"], {
      cwd: projectPath,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (probe.code !== 0) return remember(null);
    return remember(
      parseVersion(probe.stdout ?? "") ?? parseVersion(probe.stderr ?? ""),
    );
  } catch {
    return remember(null);
  }
}

export interface OutputJsonVerdict {
  supported: boolean | null;
  version: string | null;
  floor: string;
}

/* @invariant
 * Three answers, and the third one is the whole safety story.
 *
 * `true` and `false` are worth an opinion: the caller can skip a flag the
 * engine would refuse, which is the double build this exists to delete. `null`
 * means the version could not be read, could not be parsed, or the probe fell
 * over, and it must be treated exactly as the world was before this function
 * existed: send the flag and let the refusal retry catch it. The probe is an
 * optimisation, so its failure mode is losing the optimisation and never
 * breaking the build.
 */
export async function outputJsonVerdict(
  command: OutputJsonCommand,
  projectPath?: string,
): Promise<OutputJsonVerdict> {
  const floor = OUTPUT_JSON_FLOOR[command];
  let version: string | null = null;
  try {
    version = await resolvedEngineVersion(projectPath);
  } catch {
    return { supported: null, version: null, floor };
  }
  if (version === null) return { supported: null, version: null, floor };
  const ordering = compareVersions(version, floor);
  if (ordering === null) return { supported: null, version, floor };
  return { supported: ordering >= 0, version, floor };
}

/* @invariant Commander's refusal, matched in one place because the floors it
   has to be explained against live here.

   An engine that does not know --output json answers with one line on stderr
   and exits before doing any work. The match needs commander's own phrasing AND
   that line to name --output, so a command that fails for a real reason is
   never mistaken for one that refused a flag. */
const UNKNOWN_OUTPUT_FLAG = /unknown option[^\n]*--output\b/;

export function refusedTheOutputFlag(stderr: string): boolean {
  return UNKNOWN_OUTPUT_FLAG.test(stderr);
}

/* @invariant What to say when a command that cannot drop the flag is refused it.
 *
 * `build` can answer a refusal by rebuilding without the flag, because the build
 * summary it persists says everything the envelope would have. `doctor` and the
 * act family have no such second source: without --output json they print a
 * report for a human, and reading that back is exactly the prose scraping this
 * package bans. So there is nothing to retry and no cost to save; the only thing
 * left to get right is the sentence the caller reads.
 *
 * Left alone that sentence is "unknown option '--output'", which names a flag
 * the user never typed, in a command they did not run, and points at nothing.
 * The probe turns it into the two facts that actually decide what to do: the
 * version installed in this project, and the version where the flag arrived.
 *
 * Three verdicts, three sentences, because a probe that guesses is worse than
 * one that admits it does not know. Below the floor is the ordinary case and
 * gets a plain upgrade instruction. At or above the floor is a contradiction
 * worth reporting as one: the binary being run is not the version it reports,
 * which usually means a stale node_modules or a shim on PATH, and telling that
 * user to upgrade would send them round a loop that cannot terminate. An
 * unreadable version says so and still names the floor, which is the part they
 * can act on either way.
 */
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
