// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { APPROVAL_GATE_ENV, approvalGateEnabled } from "./approval-gate";
import { approvalVerdict } from "./approval-policy";
import { envelope } from "./envelope";
import { STORE_SETTINGS_ACTION } from "./store-settings";

type Args = Record<string, unknown>;

export const SUBMIT_CHECK_TOOL = "extension_submit_check";

export const SUBMIT_READ_ACTIONS = ["preflight", "status"] as const;

export const SUBMIT_SHIP_ACTIONS = ["publish", "review", "cancel", "rollout", "release", "sync-listing"] as const;

export const SUBMIT_SETTING_ACTIONS = ["configure-store"] as const;

export const SUBMIT_CONNECT_ACTIONS = ["connect"] as const;

const SHIPS = new Set<string>(SUBMIT_SHIP_ACTIONS);

const READS = new Set<string>([...SUBMIT_READ_ACTIONS, ...SUBMIT_CONNECT_ACTIONS]);

const actionOf = (args: Args): string => (typeof args.action === "string" && args.action ? args.action : "submit");

export function submitShips(args: Args): boolean {
  if (typeof args.action === "string" && SHIPS.has(args.action)) return true;

  return (args.action === undefined || args.action === "submit") && args.dryRun === false;
}

export function submitAsks(args: Args): boolean {
  const action = actionOf(args);
  if (READS.has(action)) return false;

  return action !== "submit" || args.dryRun === false;
}

const quoted = (actions: readonly string[]): string => actions.map((action) => `'${action}'`).join(", ");

const ASKING_ACTS = SUBMIT_SHIP_ACTIONS.filter((action) => action !== "sync-listing");

export const SUBMIT_ACTION_SAFETY = `Per action: ${quoted(SUBMIT_READ_ACTIONS)} and submit with dryRun true (the default) are read-only and dispatch nothing; submit with dryRun:false and no approvalId executes nothing either, it only asks for the owner's approval on extension.dev and answers approval-required, so that page is the gate; the first call of ${quoted(ASKING_ACTS)} with no approvalId only asks the same way, and so does a 'sync-listing' carrying a value the platform derives and a ${quoted(SUBMIT_SETTING_ACTIONS)} to a submission mode that sends the next upload to a review that publishes it; the call carrying the approved approvalId and ${quoted(SUBMIT_SHIP_ACTIONS)} change what a store holds, ${quoted(SUBMIT_SETTING_ACTIONS)} changes the project's store settings, and a plain sync-listing or configure-store writes at once under the owner's own token; 'connect' changes nothing a store holds and takes no key: it opens a connect page where the person hands the key straight to the platform, and waits on the platform's record. MCP annotations are per tool, so this one tool carries the destructive hint of its acts, and ${SUBMIT_CHECK_TOOL} takes the read-only calls and every approval request under a read-only hint; a client that accepts the approval page as its only gate allows this tool by name.`;

export const SUBMIT_CHECK_ACTIONS = [...SUBMIT_READ_ACTIONS, "submit", ...SUBMIT_SHIP_ACTIONS, ...SUBMIT_SETTING_ACTIONS, ...SUBMIT_CONNECT_ACTIONS] as const;

const CHECKS = new Set<string>(SUBMIT_CHECK_ACTIONS);

const RUN_THERE = "runs through extension_submit with the same arguments. Nothing was sent.";

export function plainListingAsk(store: string): string {
  return `The ${store} listing sync copies only what STORE.md and the build say, a plain act the platform writes at once under the owner's own token with no approval page, so ${SUBMIT_CHECK_TOOL} cannot ask for it; that call ${RUN_THERE}`;
}

function plainSetting(args: Args): boolean {
  const settings = args.storeSettings && typeof args.storeSettings === "object" ? (args.storeSettings as Args) : {};
  const write = { store: String(args.store ?? ""), submissionMode: String(settings.submissionMode ?? ""), releaseChannel: String(settings.releaseChannel ?? "") };

  return approvalVerdict(STORE_SETTINGS_ACTION, write) !== "approval";
}

export function submitCheckRefusal(args: Args): string | null {
  const action = actionOf(args);

  if (!CHECKS.has(action)) {
    return `${SUBMIT_CHECK_TOOL} only reads and asks for approval, and '${action}' is not an action of extension_submit. Nothing was sent.`;
  }

  if (typeof args.approvalId === "string" && args.approvalId.trim()) {
    return `${SUBMIT_CHECK_TOOL} never spends an approval: the call carrying approvalId ${args.approvalId.trim()} runs the ${action} it approved, so it ${RUN_THERE}`;
  }

  if (submitAsks(args) && !approvalGateEnabled(true)) {
    return `This server runs with ${APPROVAL_GATE_ENV} off, so a ${action} call would go to the platform without asking for an approval here first; that call ${RUN_THERE}`;
  }

  if (action === "configure-store" && plainSetting(args)) {
    return `This ${String(args.store ?? "store")} settings change is a plain write the platform makes at once under the owner's own token with no approval page (only a submission mode that sends the next upload to a review that publishes it asks for one), so ${SUBMIT_CHECK_TOOL} cannot ask for it; that call ${RUN_THERE}`;
  }

  return null;
}

export function checkRefused(action: string, reason: string): string {
  return envelope({
    ok: false,
    command: SUBMIT_CHECK_TOOL,
    status: "check-refused",
    error: { code: "E_BAD_REQUEST", name: "CheckRefused", message: reason },
    value: { action, useTool: "extension_submit" },
    hint: reason,
  });
}

export function submitCheckRefused(args: Args): string | null {
  const reason = submitCheckRefusal(args);

  return reason ? checkRefused(actionOf(args), reason) : null;
}
