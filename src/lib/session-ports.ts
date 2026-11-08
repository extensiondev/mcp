// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isGeckoFamily, WEBKIT_FAMILY } from "./browser-family";
import { PRODUCTION_DEBUG_PORT_FLOOR, productionDebugPortOutlook } from "./production-launch";

import type { ReadyContract } from "./types";

export interface SessionPorts {
  port: number | null;
  controlPort: number | null;
  cdpPort: number | null;
  rdpPort?: number;
  debugPortNote?: string;
  webdriver?: "connected" | "none" | "pending";
  webdriverNote?: string;
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

function webdriverState(contract: ReadyContract): Pick<SessionPorts, "webdriver" | "webdriverNote"> {
  if (!WEBKIT_FAMILY.has(contract.browser)) return {};

  if (portOrNull(contract.webdriverPort) !== null && typeof contract.webdriverSessionId === "string" && contract.webdriverSessionId) {
    return { webdriver: "connected" };
  }

  const reason = String(contract.webdriverUnavailableReason ?? "").trim();

  if (reason) {
    return {
      webdriver: "none",
      webdriverNote: `This run has no WebDriver window: ${reason}. extension_open url, extension_eval context "page" and extension_screenshot drive that window, so they refuse on this run, and an unloaded background can be woken only by hand (its toolbar button, or a page its content script matches opened in Safari). extension_dev with replace: true asks for a new window.`,
    };
  }

  return {
    webdriver: "pending",
    webdriverNote: "ready.json names no safaridriver session yet: the Safari launcher stamps it, or why it opened none, once its WebDriver step ends, and the session request alone waits up to 30 s. extension_wait reads it again.",
  };
}

const RDP_READY_FLOOR = "4.1.39";

function geckoNoDebugPortNote(contract: ReadyContract): string {
  const reason = String(contract.rdpPortError ?? "").trim().replace(/\.+$/, "");

  if (reason) {
    return `This ${contract.browser} session has no rdpPort: the engine says ${reason}. Firefox serves the Remote Debugging Protocol (RDP), not CDP, so the debugger tools (extension_eval over the protocol, extension_screenshot, page reads) have nothing to connect to on this run; extension_logs shows the launcher's last lines, and extension_dev with replace: true starts a new session.`;
  }

  const engine = typeof contract.toolchainVersion === "string" && contract.toolchainVersion ? ` (Extension.js ${contract.toolchainVersion})` : "";

  return `This ${contract.browser} session names no rdpPort: Firefox serves the Remote Debugging Protocol (RDP), not CDP. From Extension.js ${RDP_READY_FLOOR} a Firefox dev session turns ready only with rdpPort or rdpPortError, so this contract comes from an older engine${engine}, which stamps rdpPort after ready (4.0.15 on) or never (before 4.0.15). The debugger tools wait for it on their own and extension_wait reads it again; moving the project's extension dependency to ${RDP_READY_FLOOR} or later makes ready carry it.`;
}

function noDebugPortNote(contract: ReadyContract): string {
  if (isGeckoFamily(contract.browser)) return geckoNoDebugPortNote(contract);

  return "The session opened no browser debug port: the contract carries neither cdpPort (Chromium) nor rdpPort (Gecko), so nothing can connect a debugger to this browser; a Chromium dev session normally stamps cdpPort once the browser binds it.";
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
            : noDebugPortNote(contract),
        }
      : {}),
    ...webdriverState(contract),
  };
}
