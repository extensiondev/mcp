// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant
 * @deprecated The only module allowed to read the CLI's human output.
 *
 * Every regex here is coupled to first-party CLI copy, so a wording change in
 * the CLI silently changes agent behaviour. They survive as a fallback for a
 * project whose own `node_modules/.bin/extension` predates the machine
 * contract: `resolveExtensionInvocation` prefers that binary over the pinned
 * version, so the MCP can never assume what it is talking to.
 *
 * The condition for deleting this file, and the exemption for it in
 * `no-prose-scraping`: when the OLDEST engine this server still means to
 * support stamps `schema: 1` into ready.json. That stamp arrived in 4.0.17.
 * The condition is about the floor, NOT about the pin: a reader who checks
 * whether the pinned engine stamps it will always find that it does, and will
 * delete a fallback that only ever runs against engines older than the pin. It
 * has already been misread that way once. `legacy-stdout.test.ts` holds the
 * proof to re-run first: it shows what a pre-4.0.17 session's failure
 * degrades to without these, which is "started fine".
 *
 * Nothing else in `src/` may match on CLI prose.
 */

const MERGED_FD_CHATTER = [
  /^npm warn Unknown project config/i,
  /This will stop working in the next major version of npm/i,
  /^npm warn config/i,
  /^npm warn exec/i,
  /The following package(s)? (was|were) not found and will be installed/i,
  /V8: .*Invalid asm\.js/i,
  /^\(node:\d+\) V8:/i,
  /Use `node --trace-warnings/i,
  /Invalid asm\.js:/i,
  /Linking failure in asm\.js/i,
  /Successfully compiled asm\.js/i,
];

/** @deprecated see the module note. */
export function denoiseCliLog(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !MERGED_FD_CHATTER.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trimStart();
}

/** @deprecated Replaced by `ready.json` `status:"error"`. */
export function legacyCompileScrape(cleanOutput: string): boolean {
  return /compiled with errors|✖✖✖|ERROR in |Module not found|NOT FOUND/i.test(
    cleanOutput,
  );
}

/** @deprecated Replaced by `ready.json` `code:"profile_locked"`. */
export function legacyProfileLockScrape(cleanOutput: string): boolean {
  return /SingletonLock|ProcessSingleton|profile[^\n]*(in use|locked)|already (open|running)/i.test(
    cleanOutput,
  );
}

export const LEGACY_FIDELITY_WARNING =
  "This session ran a CLI that does not stamp the machine contract, so the boot verdict was read from the dev server's output instead of its ready contract. Diagnostics are less precise: compile errors come back as a text tail rather than a list. Upgrade the project's extension dependency to get the precise verdict.";
