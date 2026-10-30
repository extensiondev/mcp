// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { CDPClient } from "./cdp";
import { compareVersions, parseVersion } from "./engine-version";
import { pidState } from "./process-identity";
import { waitCall } from "./session-receipt";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export interface ProductionLaunchEvidence {
  browserPid: number | null;
  browserAlive: boolean | null;
  extensionId?: string;
  cdpPort?: number;
  extensionLoaded: boolean | null;
  loadEvidence: string;
}

export const PRODUCTION_SESSION_LIMITS =
  "a production session has no hot reload and carries no dev bridge, so extension_logs has no console stream for it and the bridge verbs (extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval) need allowControl: true";

export const CONTROLLED_SESSION_LIMITS =
  "a production session has no hot reload and extension_logs has no console stream for it; this session carries the control channel, and its background connecting to it (the contract's executorAttachedAt, which extension_wait reads) proves the load as well";

export const PRODUCTION_DEBUG_PORT_FLOOR = "4.1.34";

export type DebugPortOutlook =
  | { kind: "opens"; version: string | null }
  | { kind: "never"; version: string }
  | { kind: "unknown" };

export function productionDebugPortOutlook(contract: ReadyContract | null, controlRequested = false): DebugPortOutlook {
  const version = typeof contract?.toolchainVersion === "string" ? parseVersion(contract.toolchainVersion) : null;

  if (version !== null) {
    const ordering = compareVersions(version, PRODUCTION_DEBUG_PORT_FLOOR);
    if (ordering !== null) return ordering >= 0 ? { kind: "opens", version } : { kind: "never", version };
  }

  const controlled = controlRequested || (typeof contract?.controlPort === "number" && contract.controlPort > 0);

  return controlled ? { kind: "opens", version: null } : { kind: "unknown" };
}

export function debugPortWords(outlook: DebugPortOutlook): string {
  switch (outlook.kind) {
    case "opens": {
      const engine = outlook.version ? `Extension.js ${outlook.version}` : `Extension.js ${PRODUCTION_DEBUG_PORT_FLOOR} or later, the engines that take allowControl`;

      return `the engine (${engine}) stamps the browser's debug port (cdpPort) in the contract once the browser binds it, and extension_wait reads the load off that port's target list`;
    }

    case "never":
      return `this engine (Extension.js ${outlook.version}) opens no debug port on a production run (${PRODUCTION_DEBUG_PORT_FLOOR} is the first that does), so the browser's target list cannot be read from here, and only extension_dev proves the load`;
    default:
      return `extension_wait reads the load off the browser's target list once the contract stamps cdpPort, which Extension.js ${PRODUCTION_DEBUG_PORT_FLOOR} or later does on a production run; an older engine never stamps it, and only extension_dev proves the load there`;
  }
}

export function productionLoadProofLine(
  contract: ReadyContract | null,
  launch: ProductionLaunchEvidence,
  controlRequested: boolean,
  projectPath: string,
  browser: string,
): string {
  const outlook = productionDebugPortOutlook(contract, controlRequested);

  if (outlook.kind === "never") return "To prove the load, run it with extension_dev, whose answer carries guestLoaded.";
  if (typeof launch.cdpPort === "number") return `Call ${waitCall(projectPath, browser)} to read the load again over the debug port ${launch.cdpPort}.`;

  return outlook.kind === "opens"
    ? `Call ${waitCall(projectPath, browser)}: it reads the load over the browser's debug port once the contract names it (cdpPort).`
    : `Call ${waitCall(projectPath, browser)}: it reads the load over the browser's debug port if the contract stamps cdpPort, and says so if this engine never does.`;
}

export function readFreshContract(
  projectPath: string,
  browser: string,
  since: number,
): ReadyContract | null {
  try {
    const file = readyContractPath(projectPath, browser);
    if (fs.statSync(file).mtimeMs < since) return null;

    const contract = JSON.parse(fs.readFileSync(file, "utf8"));

    return contract && typeof contract === "object" ? (contract as ReadyContract) : null;
  } catch {
    return null;
  }
}

export function productionLaunchEvidence(
  contract: ReadyContract | null,
  controlRequested = false,
): ProductionLaunchEvidence {
  const browserPid =
    typeof contract?.browserPid === "number" && contract.browserPid > 0
      ? contract.browserPid
      : null;
  const browserAlive = browserPid === null ? null : pidState(browserPid) === "alive";
  const extensionId =
    typeof contract?.extensionId === "string" && contract.extensionId
      ? contract.extensionId
      : undefined;
  const controlled =
    controlRequested || (typeof contract?.controlPort === "number" && contract.controlPort > 0);
  const attachedAt =
    controlled && typeof contract?.executorAttachedAt === "string" && contract.executorAttachedAt
      ? contract.executorAttachedAt
      : null;
  const limits = controlled ? CONTROLLED_SESSION_LIMITS : PRODUCTION_SESSION_LIMITS;
  const port = debugPortWords(productionDebugPortOutlook(contract, controlRequested));

  if (attachedAt && browserAlive !== false) {
    return {
      browserPid,
      browserAlive,
      ...(extensionId ? { extensionId } : {}),
      extensionLoaded: true,
      loadEvidence: `The extension's background connected to this session's control channel at ${attachedAt}, so the browser loaded it and its background runs.`,
    };
  }

  const loadEvidence =
    browserPid === null
      ? `The contract records no browser pid yet, so not even the launch is confirmed here; extension_wait reads it once the build and the launch land. Whether the browser loaded the extension is not read yet: ${port}. Beyond that, ${limits}.`
      : browserAlive
        ? `The engine's launcher recorded the browser it spawned (pid ${browserPid}) and that process is alive, so the browser is up. Whether it loaded the extension is not read yet: ${port}. Beyond that, ${limits}.`
        : `The engine's launcher recorded the browser it spawned (pid ${browserPid}) and that process is gone, so the browser exited or handed its session to another process; nothing here says the extension loaded (${limits}).`;

  return {
    browserPid,
    browserAlive,
    ...(extensionId ? { extensionId } : {}),
    extensionLoaded: null,
    loadEvidence,
  };
}

/* @invariant
 * An engine that stamps cdpPort on a start or preview contract leaves the browser's debug port open, so the load is read off
 * the browser's own target list instead of being left unconfirmed. A target
 * under chrome-extension://<id>/ is the proof; no target is not a refusal,
 * because an extension with no background and no open page has none.
 */
export async function readLoadOverDebugPort(
  contract: ReadyContract | null,
  launch: ProductionLaunchEvidence,
): Promise<ProductionLaunchEvidence> {
  const port = typeof contract?.cdpPort === "number" && contract.cdpPort > 0 ? contract.cdpPort : null;

  if (port === null || !launch.extensionId || !launch.browserAlive) return launch;

  let targets: Array<{ type: string; url: string }>;

  try {
    targets = await CDPClient.discoverTargets(port);
  } catch {
    return {
      ...launch,
      cdpPort: port,
      loadEvidence: `The contract names the browser's debug port ${port}, but it did not answer, so the load is not read. The browser (pid ${launch.browserPid}) is alive.`,
    };
  }

  const prefix = `chrome-extension://${launch.extensionId}/`;
  const own = targets.filter((target) => String(target.url ?? "").startsWith(prefix));

  if (own.length) {
    const kinds = [...new Set(own.map((target) => target.type))].join(", ");

    return {
      ...launch,
      cdpPort: port,
      extensionLoaded: true,
      loadEvidence: `Read over the browser's debug port ${port}: ${own.length} live target${own.length === 1 ? "" : "s"} of ${launch.extensionId} (${kinds}), so the browser loaded the extension.`,
    };
  }

  return {
    ...launch,
    cdpPort: port,
    loadEvidence: `The browser's debug port ${port} answered with no target of ${launch.extensionId}. An extension with no background and no open page has none, so this neither proves nor refutes the load; open one of its pages, or run it with extension_dev.`,
  };
}
