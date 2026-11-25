// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { composedRefusal } from "./composed-refusal";

/* @invariant A PLATFORM TOOL WITH NO STEP ON THIS MACHINE ANSWERS ONLY FROM
 * THE HOSTED LANE. This package lists the tool and forwards the call; the
 * code that answers it runs on mcp.extension.dev. A call that reaches this
 * handler was not forwarded, so it says so instead of answering for the
 * platform.
 */
export function hostedOnly(command: string): (args: Record<string, unknown>) => Promise<string> {
  return async () =>
    composedRefusal({
      ok: false,
      command,
      status: "hosted-only",
      error: { code: "E_TOOL_DISABLED", message: `${command} has no step that runs on this machine: extension.dev's hosted lane answers it.` },
      hint: `Call ${command} through this server's tool list, which forwards it to the hosted lane.`,
      value: { hosted: true },
    });
}

export function hostedServerOnly(command: string): string {
  return composedRefusal({
    ok: false,
    command,
    status: "hosted-only",
    error: { code: "E_TOOL_DISABLED", message: `${command} reads or changes the source extension.dev stores, and only the hosted server at https://mcp.extension.dev/mcp serves it. Nothing was read or changed.` },
    hint: "This server works on the project folder on this machine: read and edit its files there.",
    value: { hosted: true },
  });
}

export function storedSourceClosed(command: string): string {
  return composedRefusal({
    ok: false,
    command,
    status: "hosted-unavailable",
    error: { code: "E_TOOL_DISABLED", message: `${command} reads or changes the source extension.dev stores, and stored project source is not open on this server yet. Nothing was read or changed.` },
    hint: "To work on a project folder on the person's machine, use the local server (npx @extension.dev/mcp) and read or edit its files there.",
    value: { hosted: true },
  });
}
