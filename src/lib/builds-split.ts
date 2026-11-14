// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const BUILDS_READ_TOOL = "extension_builds";
export const BUILDS_ACT_TOOL = "extension_builds_act";
export const READ_ACTIONS = ["list", "get", "logs", "download"] as const;
export const ACT_ACTIONS = ["rebuild", "recheck", "configure", "create-channel", "configure-channel", "delete-channel"] as const;

/* @invariant ONE TOOL READS BUILDS AND ANOTHER CHANGES THEM. Until 11.0.0
 * extension_builds did both, which a client that approves read tools on its
 * own cannot tell apart, and both connector directories refuse (ledger 525,
 * Cezar's ruling of 2026-11-14). The read tool lists, gets, reads logs and
 * downloads; the act tool rebuilds, rechecks, configures and runs the
 * channel acts. An act name sent to the read tool is answered with the tool
 * that now takes it, and nothing runs.
 */
export function movedActHint(asked: unknown): string | undefined {
  const action = typeof asked === "string" ? asked.trim() : "";
  if (!(ACT_ACTIONS as readonly string[]).includes(action)) return undefined;

  return `${action} moved to ${BUILDS_ACT_TOOL} in 11.0.0: call ${BUILDS_ACT_TOOL} {action: "${action}"} with the same arguments. ${BUILDS_READ_TOOL} only reads and downloads now, and nothing ran.`;
}
