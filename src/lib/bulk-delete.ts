// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";

type Args = Record<string, unknown>;

/* @invariant A CALL THAT DELETES MORE THAN ONE THING SAYS confirm: true.
 * A directory review refuses a tool that deletes in bulk on one call
 * (ledger 1141), and an agent that sends all: true or a list of names by
 * mistake loses every one of them at once. So a bulk delete answers
 * confirm-required and deletes nothing until the same call carries
 * confirm: true, as extension_stop all: true across projects already did;
 * one item per call needs no confirm. extension_network_stub clear reads its
 * live rule count in its own handler, since only it holds the rules.
 */
const browsersUninstallAll = (args: Args): string | null =>
  args.action === "uninstall" && args.all === true ? "uninstall with all: true removes every managed browser binary" : null;

const variablesRemoved = (args: Args): string | null =>
  args.action === "set-environment" && Array.isArray(args.remove) && args.remove.length > 1 ? `set-environment deletes ${args.remove.length} build variables in one call` : null;

const BULK: Record<string, (args: Args) => string | null> = {
  extension_browsers: browsersUninstallAll,
  extension_browsers_install: (args) => browsersUninstallAll({ ...args, action: args.action ?? "install" }),
  extension_workspace: variablesRemoved,
  extension_workspace_configure: (args) => variablesRemoved({ ...args, action: args.action ?? "set-visibility" }),
};

export function confirmRequired(command: string, what: string, hint: string, value: Args = {}): string {
  return envelope({
    ok: false,
    command,
    status: "confirm-required",
    error: { code: "E_BAD_REQUEST", message: `Nothing was deleted: ${what}, which takes confirm: true.` },
    value,
    hint,
  });
}

export function bulkDeleteRefusal(name: string, args: Args): string | null {
  const what = BULK[name]?.(args);

  if (!what || args.confirm === true) return null;

  return confirmRequired(name, what, "Call again with confirm: true to delete them all, or name one item per call, which needs no confirm.");
}

/* @invariant A REFUSAL NAMES ONLY AN ARGUMENT ITS READER'S TOOL TAKES.
 * confirm arrived after 11.3.0, so a forwarder at 11.3.0 or older refuses it
 * as an unknown argument, and an agent told to call again with confirm: true
 * met that refusal (ledger 1272). An answer bound for such a forwarder names
 * one item per call, the route its schema can take.
 */
const TAKES_CONFIRM = ", which takes confirm: true.";

export const ONE_ITEM_PER_CALL_HINT =
  "Call again once per item, naming one item per call, which needs no confirm: this server's version of the tool takes no confirm argument.";

export function oneItemPerCall<T>(answer: T): T {
  const told = answer as { status?: unknown; error?: { message?: unknown; hint?: unknown } } | null;
  const message = told?.error?.message;

  if (!told || typeof told !== "object" || told.status !== "confirm-required" || typeof message !== "string" || !message.endsWith(TAKES_CONFIRM)) return answer;

  return { ...told, error: { ...told.error, message: `${message.slice(0, -TAKES_CONFIRM.length)}. This server's version of the tool deletes one item per call.`, ...(told.error?.hint === undefined ? {} : { hint: ONE_ITEM_PER_CALL_HINT }) }, hint: ONE_ITEM_PER_CALL_HINT } as T;
}

export const CONFIRM_INPUT = {
  type: "boolean",
  default: false,
  description: "true confirms a delete of more than one item in one call.",
} as const;
