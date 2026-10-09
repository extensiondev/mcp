// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ReadyContract } from "./types";

export interface SessionPorts {
  port: number | null;
  controlPort: number | null;
  cdpPort: number | null;
  rdpPort?: number;
  debugPortNote?: string;
}

function portOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sessionPorts(contract: ReadyContract): SessionPorts {
  const cdpPort = portOrNull(contract.cdpPort);
  const rdpPort = portOrNull(contract.rdpPort);
  const production = contract.command === "start" || contract.command === "preview";

  return {
    port: portOrNull(contract.port),
    controlPort: portOrNull(contract.controlPort),
    cdpPort,
    ...(rdpPort !== null ? { rdpPort } : {}),
    ...(cdpPort === null && rdpPort === null
      ? {
          debugPortNote: production
            ? `This ${contract.command} session opened no browser debug port: the engine runs a production launch without CDP or RDP, so there is no port to connect a debugger or a target list to.`
            : "The session opened no browser debug port: the contract carries neither cdpPort (Chromium) nor rdpPort (Gecko), so nothing can connect a debugger to this browser; a Chromium dev session normally stamps cdpPort once the browser binds it.",
        }
      : {}),
  };
}
