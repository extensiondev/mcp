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

/* @invariant
 * The sentence a caller appends when a session artifact is missing, so a
 * layout mismatch between this package's pinned engine and the engine actually
 * installed in the project reads as a wrong-path problem instead of silence.
 */
export function sessionPathHint(file: string): string {
  return `Looked at ${file} (the session-state layout this MCP's pinned engine publishes). If the project runs an older Extension.js, its layout may differ and this path will never appear.`;
}
