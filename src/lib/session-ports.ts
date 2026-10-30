// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PRODUCTION_DEBUG_PORT_FLOOR, productionDebugPortOutlook } from "./production-launch";

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

function productionDebugPortNote(contract: ReadyContract): string {
  const outlook = productionDebugPortOutlook(contract);

  switch (outlook.kind) {
    case "opens":
      return `This ${contract.command} session names no browser debug port yet: the engine (Extension.js ${outlook.version ?? `${PRODUCTION_DEBUG_PORT_FLOOR} or later`}) stamps cdpPort once the browser binds it, so call extension_wait again for it.`;
    case "never":
      return `This ${contract.command} session opened no browser debug port: Extension.js ${outlook.version} runs a production launch without CDP or RDP (${PRODUCTION_DEBUG_PORT_FLOOR} is the first that opens one), so there is no port to connect a debugger or a target list to.`;
    default:
      return `This ${contract.command} session names no browser debug port: an engine of Extension.js ${PRODUCTION_DEBUG_PORT_FLOOR} or later stamps cdpPort once the browser binds it, and an older one runs a production launch without CDP or RDP.`;
  }
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
            ? productionDebugPortNote(contract)
            : "The session opened no browser debug port: the contract carries neither cdpPort (Chromium) nor rdpPort (Gecko), so nothing can connect a debugger to this browser; a Chromium dev session normally stamps cdpPort once the browser binds it.",
        }
      : {}),
  };
}
