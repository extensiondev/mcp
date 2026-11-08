// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const RDP_READY_FLOOR = "4.1.39";

export type RdpPortRead = { port: number | null; rdpPortError?: string } | null | undefined;

export const RDP_PORT_ERROR_NEXT_STEP = "extension_logs shows the launcher's last lines, and extension_dev with replace: true starts a new session";

export function rdpPortErrorReason(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\.+$/, "") : "";
}

export function olderGeckoEngineNote(engine = ""): string {
  return `From Extension.js ${RDP_READY_FLOOR} a Firefox dev session turns ready only with rdpPort or rdpPortError, so this contract comes from an older engine${engine}, which stamps rdpPort after ready (4.0.15 on) or never (before 4.0.15)`;
}

export const RDP_PORT_MISSING_HINT = `The session's ready contract has no rdpPort. ${olderGeckoEngineNote()}. Move the project's extension dependency to ${RDP_READY_FLOOR} or later (or remove the local install so the MCP's pinned CLI drives the session) and restart the dev session.`;

export function rdpPortMissingHint(miss: RdpPortRead): string {
  const reason = rdpPortErrorReason(miss?.rdpPortError);

  return reason ? `Firefox opened no debugger (RDP) port on this run: the engine says ${reason}; ${RDP_PORT_ERROR_NEXT_STEP}.` : RDP_PORT_MISSING_HINT;
}

export function rdpPortMissingReason(miss: RdpPortRead): string {
  const reason = rdpPortErrorReason(miss?.rdpPortError);

  return reason
    ? `Firefox opened no debugger (RDP) port on this run, the engine says ${reason} (${RDP_PORT_ERROR_NEXT_STEP})`
    : "the session's ready contract records no debugger (RDP) port";
}
