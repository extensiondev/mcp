// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { CDPClient } from "./cdp";
import { pidState } from "./process-identity";
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
  "a production launch opens no debug port and carries no dev bridge, so neither the browser's target list nor its console can be read from here; extension_logs has no stream for this session and the control verbs cannot attach";

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
  const loadEvidence =
    browserPid === null
      ? `The contract records no browser pid yet, so not even the launch is confirmed here; extension_wait reads it once the build and the launch land. Whether the browser loads the extension stays unread either way: ${PRODUCTION_SESSION_LIMITS}.`
      : browserAlive
        ? `The engine's launcher recorded the browser it spawned (pid ${browserPid}) and that process is alive, so the browser is up. Whether it loaded the extension is not read: ${PRODUCTION_SESSION_LIMITS}.`
        : `The engine's launcher recorded the browser it spawned (pid ${browserPid}) and that process is gone, so the browser exited or handed its session to another process; nothing here says the extension loaded (${PRODUCTION_SESSION_LIMITS}).`;

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
