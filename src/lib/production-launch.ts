// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { pidState } from "./process-identity";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export interface ProductionLaunchEvidence {
  browserPid: number | null;
  browserAlive: boolean | null;
  extensionId?: string;
  extensionLoaded: null;
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
