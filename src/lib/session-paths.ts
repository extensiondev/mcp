// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant This module is the ONLY place in the MCP that is allowed to know
   where a dev session keeps its state on disk, and it knows it by importing the
   engine's own published helpers rather than by rebuilding
   dist/extension-js/<browser>/... out of string literals. The literals were
   spread across nine call sites; a layout change in the engine turned every one
   of them into a read that finds nothing and reports "no session" instead of
   "wrong path", which is the worst possible failure because it looks like a
   correct answer.

   Version skew is real and it does not go away by importing the helpers. The
   MCP drives whatever engine the USER'S project has installed
   (resolveExtensionInvocation prefers node_modules/.bin/extension), which can be
   older than the engine this package pins. These helpers therefore describe the
   PINNED engine's layout, which is a claim about the running engine, not a fact
   about it. That is still strictly better than literals: literals are frozen at
   whatever the layout happened to be when someone typed them, and they drift
   silently in BOTH directions. A helper at least moves with a reviewable version
   bump. What the helper cannot do is make a mismatch visible, so every caller
   that reports "nothing found" MUST name the absolute path it looked at.
   sessionPathHint exists for exactly that. */

import path from "node:path";
import { sessionArtifactsRootDir } from "extension-develop/bridge";

export {
  actionsPath,
  browserArtifactsDir,
  buildSummaryPath,
  eventsPath,
  logsPath,
  readyContractPath,
  sessionArtifactsRootDir,
  sessionStateDir,
} from "extension-develop/bridge";

/* @invariant The engine's own reader for the contract those paths point at,
   re-exported here rather than imported directly so the path and the parse stay
   in one place. It answers exactly one question, "can this process dial the
   control channel", and it answers null whenever controlPort is not a number or
   instanceId is missing. It also drops code, errors, message, status and pid.

   So it is right for a follow read and wrong for anything that has to form a
   verdict about a session, which is why adopting it here does NOT make it the
   one reader. Several callers still parse ready.json themselves on purpose:
   tools/doctor.ts (needs code, errors and message, and must not vanish on a
   session with no control port), lib/boot-verdict.ts (needs the file's mtime for
   freshness), lib/cdp-port.ts (needs cdpPort and rdpPort), tools/wait.ts and
   tools/stop.ts (need status and pid). tools/logs.ts uses both: this reader to
   dial, and its own parse for the pid-and-status warnings. Only the PATH has a
   single owner; the shape does not, and a sweep that consolidates on that
   assumption will delete a check rather than a copy. */
export {
  readReadyContract,
  type ReadyContractInfo,
} from "extension-develop/bridge";

/* @invariant
 * The sentence a caller appends when a session artifact is missing, so a
 * layout mismatch between this package's pinned engine and the engine actually
 * installed in the project reads as a wrong-path problem instead of silence.
 */
export function sessionPathHint(file: string): string {
  return `Looked at ${file} (the session-state layout this MCP's pinned engine publishes). If the project runs an older Extension.js, its layout may differ and this path will never appear.`;
}

/* @invariant Everything below models the managed browser-profile layout, and it
   is a MODEL rather than an adoption. The engine publishes no profile helper and
   stamps no profile path into ready.json, so unlike the session artifacts above
   there is nothing to import: the engine builds
   `<distRoot>/extension-js/profiles/<browser>-profile` inside each launcher
   (run-chromium/chromium-launch/browser-config.ts and
   run-firefox/firefox-launch/browser-config.ts) and never exports it. That gap
   is filed upstream as section 94 of the engine's BUGS_TO_FIX.md; when the
   engine ships browserProfileRootDir and stamps the resolved profile into the
   contract, these functions become re-exports and the reads below become reads
   of a published fact.

   Until then the guess lives here and only here, because the previous copy of it
   was spread across a remediation string and a pgrep pattern and both were
   wrong: they still said dist/extension-profile-<browser>, a layout no shipping
   engine has written for some time. The remediation named a directory that could
   not exist, and the pgrep pattern that was supposed to reap the session's
   browser matched nothing, so extension_stop reported a clean stop over a live
   browser. One place to be wrong is the whole point; two places to be wrong is
   how this shipped.

   Only the leading segment is borrowed rather than guessed:
   sessionArtifactsRootDir is the engine's own helper, so `dist/extension-js`
   moves with the pin. `profiles` and the `<browser>-profile` suffix are the
   guess.

   What this deliberately does NOT model is the run directory inside
   <browser>-profile. A persisted profile gets `dev`; an ephemeral one gets three
   random words from uniqueNamesGenerator, freshly drawn on every restart
   (resolve-profile.ts). That name is unguessable in principle, not merely in
   practice, so no function here returns a full profile path, and any caller that
   needs one has to look at the directory instead of computing it. */
export function profilesRootDir(projectPath: string): string {
  return path.join(sessionArtifactsRootDir(projectPath), "profiles");
}

export function browserProfileRootDir(
  projectPath: string,
  browser: string,
): string {
  return path.join(profilesRootDir(projectPath), `${browser}-profile`);
}

export const PERSISTED_PROFILE_DIR_NAME = "dev";

export interface ProfileRemediationInput {
  projectPath: string;
  browser: string;
  profile?: string;
}

/* @invariant The remediation sentence lives beside the path so it can never name
   a directory this module does not build, which is exactly how the old advice
   went stale. It also answers the three profile modes separately, because the
   engine does: `profile:"false"` runs the browser's own profile and there is
   nothing of ours to delete, an explicit path is the user's own directory, and
   only the default managed case lands under our root. Telling a user to delete
   their real Chrome profile would be worse than naming a path that does not
   exist. */
export function profileRemediation(input: ProfileRemediationInput): string {
  const { projectPath, browser, profile } = input;
  const raw = typeof profile === "string" ? profile.trim() : "";

  if (raw.toLowerCase() === "false") {
    return `This session was launched with profile:"false", so it runs your real ${browser} profile and there is no Extension.js profile directory to remove. Quit the ${browser} window that holds it and start again.`;
  }

  if (raw.length > 0) {
    const explicit = path.isAbsolute(raw) ? raw : path.resolve(projectPath, raw);
    return `This session was launched against the profile you passed, ${explicit}. Close whatever still holds it, or remove that directory, before retrying.`;
  }

  const root = browserProfileRootDir(projectPath, browser);
  return `The engine keeps this session's profile in a directory inside ${root}, one per run: "${PERSISTED_PROFILE_DIR_NAME}" when the profile is persisted, otherwise three random words drawn fresh on every start, which no caller can predict. List ${root} to see which run directories exist and remove the one the stuck browser holds, or remove ${root} entirely once no session is running.`;
}
