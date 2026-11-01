// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { APPROVAL_GATE_ENV, approvalGateEnabled } from "./approval-gate";
import { envelope } from "./envelope";

type Args = Record<string, unknown>;

export const SUBMIT_CHECK_TOOL = "extension_submit_check";

export const SUBMIT_READ_ACTIONS = ["preflight", "status"] as const;

export const SUBMIT_SHIP_ACTIONS = ["publish", "review", "cancel", "rollout", "release", "sync-listing"] as const;

export const SUBMIT_SETTING_ACTIONS = ["configure-store"] as const;

const SHIPS = new Set<string>(SUBMIT_SHIP_ACTIONS);

export function submitShips(args: Args): boolean {
  if (typeof args.action === "string" && SHIPS.has(args.action)) return true;

  return (args.action === undefined || args.action === "submit") && args.dryRun === false;
}

const quoted = (actions: readonly string[]): string => actions.map((action) => `'${action}'`).join(", ");

export const SUBMIT_ACTION_SAFETY = `Per action: ${quoted(SUBMIT_READ_ACTIONS)} and submit with dryRun true (the default) are read-only and dispatch nothing; submit with dryRun:false and no approvalId executes nothing either, it only asks for the owner's approval on extension.dev and answers approval-required, so that page is the gate; the submit call carrying the approved approvalId and ${quoted(SUBMIT_SHIP_ACTIONS)} change what a store holds, and ${quoted(SUBMIT_SETTING_ACTIONS)} changes the project's store settings. MCP annotations are per tool, so this one tool carries the destructive hint of its acts, and ${SUBMIT_CHECK_TOOL} takes the read-only calls and the approval request under a read-only hint; a client that accepts the approval page as its only gate allows this tool by name.`;

export const SUBMIT_CHECK_ACTIONS = [...SUBMIT_READ_ACTIONS, "submit"] as const;

const CHECKS = new Set<string>(SUBMIT_CHECK_ACTIONS);

export function submitCheckRefusal(args: Args): string | null {
  const action = typeof args.action === "string" && args.action ? args.action : "submit";

  if (!CHECKS.has(action)) {
    return `${SUBMIT_CHECK_TOOL} only reads and asks for approval: action '${action}' changes what a store or the project holds, so it runs through extension_submit. Nothing was sent.`;
  }

  if (typeof args.approvalId === "string" && args.approvalId.trim()) {
    return `${SUBMIT_CHECK_TOOL} never spends an approval: the call carrying approvalId ${args.approvalId.trim()} sends the build, so it runs through extension_submit with the same arguments. Nothing was sent.`;
  }

  if (action === "submit" && args.dryRun === false && !approvalGateEnabled(true)) {
    return `This server runs with ${APPROVAL_GATE_ENV} off, so a submit with dryRun:false would go to the platform without asking for an approval here first; that call runs through extension_submit. Nothing was sent.`;
  }

  return null;
}

export function submitCheckRefused(args: Args): string | null {
  const reason = submitCheckRefusal(args);
  if (!reason) return null;

  return envelope({
    ok: false,
    command: SUBMIT_CHECK_TOOL,
    status: "check-refused",
    error: { code: "E_BAD_REQUEST", name: "CheckRefused", message: reason },
    value: { action: typeof args.action === "string" ? args.action : "submit", useTool: "extension_submit" },
    hint: reason,
  });
}
