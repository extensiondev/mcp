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

export const CONFIRM_INPUT = {
  type: "boolean",
  default: false,
  description: "true confirms a delete of more than one item in one call.",
} as const;
