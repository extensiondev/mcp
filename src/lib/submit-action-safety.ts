// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

type Args = Record<string, unknown>;

export const SUBMIT_READ_ACTIONS = ["preflight", "status"] as const;

export const SUBMIT_SHIP_ACTIONS = ["publish", "review", "cancel", "rollout", "release", "sync-listing"] as const;

export const SUBMIT_SETTING_ACTIONS = ["configure-store"] as const;

const SHIPS = new Set<string>(SUBMIT_SHIP_ACTIONS);

export function submitShips(args: Args): boolean {
  if (typeof args.action === "string" && SHIPS.has(args.action)) return true;

  return (args.action === undefined || args.action === "submit") && args.dryRun === false;
}

const quoted = (actions: readonly string[]): string => actions.map((action) => `'${action}'`).join(", ");

export const SUBMIT_ACTION_SAFETY = `Per action: ${quoted(SUBMIT_READ_ACTIONS)} and submit with dryRun true (the default) are read-only and dispatch nothing; submit with dryRun:false and no approvalId executes nothing either, it only asks for the owner's approval on extension.dev and answers approval-required, so that page is the gate; the submit call carrying the approved approvalId and ${quoted(SUBMIT_SHIP_ACTIONS)} change what a store holds, and ${quoted(SUBMIT_SETTING_ACTIONS)} changes the project's store settings. MCP annotations are per tool, so this one tool carries the destructive hint of its acts; a client that accepts the approval page as its only gate allows this tool by name.`;
