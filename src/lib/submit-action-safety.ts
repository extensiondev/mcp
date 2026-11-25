// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { approvalVerdict, namesRealMode } from "./approval-policy";
import { envelope, isEnvelope, reframed } from "./envelope";
import { STORE_SETTINGS_ACTION } from "./store-settings";

type Args = Record<string, unknown>;

export const SUBMIT_CHECK_TOOL = "extension_submit_check";

export const SUBMIT_READ_ACTIONS = ["preflight", "status"] as const;

export const SUBMIT_SHIP_ACTIONS = ["publish", "review", "cancel", "rollout", "release", "sync-listing", "mint-signing"] as const;

export const SUBMIT_SETTING_ACTIONS = ["configure-store"] as const;

export const SUBMIT_CONNECT_ACTIONS = ["connect", "first-submission"] as const;

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

export const SUBMIT_READ_TOOL = "extension_submit_read";

export const SUBMIT_WRITE_SAFETY = `submit with dryRun:false and no approvalId executes nothing, it only asks the owner's approval, as does the first call of any store act; ${SUBMIT_READ_TOOL} answers ${quoted(SUBMIT_READ_ACTIONS)} and ${SUBMIT_CHECK_TOOL} a dry run.`;

export const SUBMIT_ACTION_SAFETY = `${quoted(SUBMIT_READ_ACTIONS)} and submit with dryRun true are read-only; submit with dryRun:false and no approvalId executes nothing either, it only asks the owner's approval, as does the first call of any store act.`;

export const SUBMIT_CHECK_ACTIONS = [...SUBMIT_READ_ACTIONS, "submit", ...SUBMIT_SHIP_ACTIONS, ...SUBMIT_SETTING_ACTIONS, ...SUBMIT_CONNECT_ACTIONS] as const;

export const SUBMIT_CHECK_LISTED_ACTIONS = SUBMIT_CHECK_ACTIONS.filter((action) => !(SUBMIT_READ_ACTIONS as readonly string[]).includes(action));

const CHECKS = new Set<string>(SUBMIT_CHECK_ACTIONS);

const RUN_THERE = "runs through extension_submit with the same arguments. Nothing was sent.";

export function plainListingAsk(store: string): string {
  return `The ${store} listing sync copies only what STORE.md and the build say, a plain act the platform writes at once under the owner's own token with no approval page, so ${SUBMIT_CHECK_TOOL} cannot ask for it; that call ${RUN_THERE}`;
}

/* @invariant A WRITE THAT MAY TAKE A STORE OUT OF ITS DRY RUN IS THE LANE'S
 * TO JUDGE. Leaving a dry run asks the owner whatever real mode it lands on
 * (ledger 888), and whether a write leaves one depends on the saved mode,
 * which only the platform holds. So a settings write that names a real
 * submission mode is never refused here as plain: it goes to the lane, which
 * reads the saved mode and answers the approval ask for a dry-run exit and
 * the plain-write sentence for every other move (ledger 893). The way into a
 * dry run, and a write that names no mode, cannot leave one and stay plain.
 * A write that names the store version source goes to the lane the same way:
 * the platform keeps a change of it on the approve page, and only the saved
 * value says whether this write is a change.
 */
function plainSetting(args: Args): boolean {
  const settings = args.storeSettings && typeof args.storeSettings === "object" ? (args.storeSettings as Args) : {};
  const write = { store: String(args.store ?? ""), submissionMode: String(settings.submissionMode ?? ""), releaseChannel: String(settings.releaseChannel ?? "") };

  return approvalVerdict(STORE_SETTINGS_ACTION, write) !== "approval" && !namesRealMode(write) && !("versionSource" in settings);
}

export function plainSettingAsk(store: string): string {
  return `This ${store} settings change is a plain write the platform makes at once under the owner's own token with no approval page (only a submission mode that takes the store out of its dry run, or that sends the next upload to a review that publishes it, asks for one, as does a change of the store version source), so ${SUBMIT_CHECK_TOOL} cannot ask for it; that call ${RUN_THERE}`;
}

export function submitCheckRefusal(args: Args): string | null {
  const action = actionOf(args);

  if (!CHECKS.has(action)) {
    return `${SUBMIT_CHECK_TOOL} only reads and asks for approval, and '${action}' is not an action of extension_submit. Nothing was sent.`;
  }

  if (typeof args.approvalId === "string" && args.approvalId.trim()) {
    return `${SUBMIT_CHECK_TOOL} never spends an approval: the call carrying approvalId ${args.approvalId.trim()} runs the ${action} it approved, so it ${RUN_THERE}`;
  }

  if (action === "configure-store" && plainSetting(args)) {
    return plainSettingAsk(String(args.store ?? "store"));
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

/* @invariant AN ANSWER NAMES THE TOOL THAT WAS CALLED. The check tool runs
 * extension_submit's handler, whose envelopes carry extension_submit as the
 * command, so an approval asked through extension_submit_check read as an
 * answer of the other tool (ledger 410). The command is rewritten to the tool
 * the client named; the sentences inside already name extension_submit as
 * the call that spends the approval.
 */
export function answeredAs(out: string, calledAs: string, actedAs: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed) || parsed.command !== actedAs) return out;

  const { schema: _schema, ...frame } = parsed;

  return reframed({ ...frame, command: calledAs });
}
