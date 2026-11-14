// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";

/* @invariant A PLATFORM TOOL WITH NO STEP ON THIS MACHINE ANSWERS ONLY FROM
 * THE HOSTED LANE. This package lists the tool and forwards the call; the
 * code that answers it runs on mcp.extension.dev. A call that reaches this
 * handler was not forwarded, so it says so instead of answering for the
 * platform.
 */
export function hostedOnly(command: string): (args: Record<string, unknown>) => Promise<string> {
  return async () =>
    envelope({
      ok: false,
      command,
      status: "hosted-only",
      error: { code: "E_TOOL_DISABLED", message: `${command} has no step that runs on this machine: extension.dev's hosted lane answers it.` },
      hint: `Call ${command} through this server's tool list, which forwards it to the hosted lane.`,
      value: { hosted: true },
    });
}
