// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { noteCallWait } from "./call-waits";
import { readyContractPath } from "./session-paths";
import { contractPidState } from "./contract-pids";
import { rdpPortErrorReason } from "./rdp-port-notes";
import { landingRun, type LandingRun } from "./start-landing";

import type { ReadyContract } from "./types";

export interface PortWaitOptions {
  waitMs?: number;
  graceMs?: number;
  timeoutMs?: number;
}

type PortField = "cdpPort" | "rdpPort";

type PortContract = ReadyContract & { cdpPort?: number; rdpPort?: number; pid?: number };

export type RdpPortMiss = { port: null; rdpPortError: string };

export type RdpPortAnswer = { port: number; source: "contract" } | RdpPortMiss | null;

function readContract(readyPath: string): PortContract | null {
  try {
    return JSON.parse(fs.readFileSync(readyPath, "utf8")) as PortContract;
  } catch {
    return null;
  }
}

export function waitedForStartLine(landing: LandingRun, browser: string, waitedMs: number): string {
  const verb = landing.verb === "dev" ? "extension_dev" : "extension_start";

  return `This call waited ${(waitedMs / 1000).toFixed(1)} s for the ${browser} ${verb} run to land (its ready.json ${landing.seen}) before answering.`;
}

async function resolveContractPort(
  projectPath: string,
  browser: string,
  field: PortField,
  options: PortWaitOptions | undefined,
  landingAllowed: boolean,
): Promise<{ port: number | null; contractSeen: boolean; portError?: string }> {
  const waitMs = options?.waitMs ?? 20_000;
  const graceMs = options?.graceMs ?? 2_500;
  const landingWaitMs = landingAllowed ? Math.max(options?.timeoutMs ?? waitMs, 0) : 0;
  const readyPath = readyContractPath(projectPath, browser);

  const start = Date.now();
  const deadline = start + waitMs;
  let contractSeen = false;
  let contractSeenAt: number | null = null;
  let landing: LandingRun | null = null;

  for (;;) {
    const contract = readContract(readyPath);
    const now = Date.now();

    if (contract) {
      contractSeen = true;
      if (contractSeenAt == null) contractSeenAt = now;

      const engineState = contractPidState(projectPath, browser, contract, "engine");
      const engineGone = engineState !== null && engineState !== "alive";

      if (!engineGone && typeof contract[field] === "number") {
        if (landing) noteCallWait(waitedForStartLine(landing, browser, now - start));

        return { port: contract[field] as number, contractSeen };
      }

      const portError = field === "rdpPort" && !engineGone ? rdpPortErrorReason(contract.rdpPortError) : "";
      if (portError) return { port: null, contractSeen, portError };

      landing = landingWaitMs > 0 ? landingRun(projectPath, browser, now) : null;
      if (engineGone && !landing) return { port: null, contractSeen };
    } else {
      landing = landingWaitMs > 0 ? landingRun(projectPath, browser, now) : null;
      if (!contractSeen && !landing) break;
    }

    const effectiveDeadline = landing
      ? Math.min(landing.deadline, start + landingWaitMs)
      : contractSeenAt != null
        ? Math.min(deadline, contractSeenAt + graceMs)
        : deadline;
    if (now >= effectiveDeadline) break;

    await sleep(500);
  }

  return { port: null, contractSeen };
}

export async function resolveCdpPort(
  projectPath: string,
  browser: string,
  options?: PortWaitOptions,
): Promise<{ port: number; source: "contract" } | null> {
  const { port } = await resolveContractPort(
    projectPath,
    browser,
    "cdpPort",
    options,
    true,
  );

  return port != null ? { port, source: "contract" } : null;
}

export async function resolveRdpPort(
  projectPath: string,
  browser: string,
  options?: PortWaitOptions,
): Promise<RdpPortAnswer> {
  const { port, portError } = await resolveContractPort(
    projectPath,
    browser,
    "rdpPort",
    options,
    false,
  );

  if (port != null) return { port, source: "contract" };

  return portError ? { port: null, rdpPortError: portError } : null;
}

export const CDP_PORT_MISSING_HINT =
  "The session's ready contract has no CDP port (the browser may still be binding its debug port, or was launched without one). Confirm the session with extension_wait, give it a moment, and retry.";

export { RDP_PORT_MISSING_HINT, rdpPortMissingHint, rdpPortMissingReason } from "./rdp-port-notes";
