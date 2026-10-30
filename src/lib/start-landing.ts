// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { pidState } from "./process-identity";
import { findSessionInfo, sessionSinceMs } from "./process-manager";
import { productionDebugPortOutlook } from "./production-launch";
import { readSessionReceipt } from "./session-receipt";

import type { ProcessInfo, ReadyContract } from "./types";

export const BOOT_CHECK_MS = 5_000;

export const START_WAIT_BUDGET_MS = 45_000;

export const LANDING_BUDGET_MS = BOOT_CHECK_MS + START_WAIT_BUDGET_MS;

export interface LandingRun {
  verb: "start" | "preview" | "dev";
  since: number;
  deadline: number;
  seen: string;
}

function alive(pid: number | undefined): boolean {
  return typeof pid === "number" && pidState(pid) === "alive";
}

function contractStamp(contract: ReadyContract): number | null {
  for (const raw of [contract.startedAt, contract.ts]) {
    if (typeof raw !== "string") continue;

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function runSince(contract: ReadyContract, registered: ProcessInfo | undefined, since: number | null): number | null {
  if (registered && since !== null && registered.pid === contract.pid) return since;

  return contractStamp(contract) ?? since;
}

function landing(verb: LandingRun["verb"], since: number | null, now: number, seen: string): LandingRun | null {
  if (since === null) return null;

  const deadline = since + LANDING_BUDGET_MS;

  return deadline > now ? { verb, since, deadline, seen } : null;
}

export function landingRun(projectPath: string, browser: string, now = Date.now()): LandingRun | null {
  const receipt = readSessionReceipt(projectPath, browser);
  if (receipt.kind === "build") return null;

  const registered = findSessionInfo(projectPath, browser);
  const registeredAlive = registered !== undefined && alive(registered.pid);
  const since = sessionSinceMs(projectPath, browser);

  if (receipt.kind === "none") {
    if (!registeredAlive) return null;

    return landing(registered.command, since, now, "had not been written yet when the call arrived");
  }

  const { contract } = receipt;

  if (receipt.kind === "production") {
    if (receipt.cdpPort !== null) return null;

    if (receipt.phase === "engine-gone") {
      if (!registeredAlive || registered.pid === contract.pid) return null;

      return landing(registered.command, since, now, "still described the run being replaced when the call arrived");
    }

    if (receipt.phase !== "starting" && receipt.phase !== "ready") return null;
    if (productionDebugPortOutlook(contract, receipt.controlRequested === true).kind === "never") return null;

    return landing(receipt.verb, runSince(contract, registered, since), now, `read status ${contract.status} when the call arrived`);
  }

  if (!alive(contract.pid) || contract.status !== "starting" || typeof contract.cdpPort === "number") return null;

  return landing("dev", runSince(contract, registered, since), now, "read status starting when the call arrived");
}
