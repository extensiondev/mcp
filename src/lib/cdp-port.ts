// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { readyContractPath } from "./session-paths";
import { pidState } from "./process-identity";

import type { ReadyContract } from "./types";

async function resolveContractPort(
  projectPath: string,
  browser: string,
  field: "cdpPort" | "rdpPort",
  options?: { waitMs?: number; graceMs?: number },
): Promise<{ port: number | null; contractSeen: boolean }> {
  const waitMs = options?.waitMs ?? 20_000;
  const graceMs = options?.graceMs ?? 2_500;
  const readyPath = readyContractPath(projectPath, browser);

  const deadline = Date.now() + waitMs;
  let contractSeen = false;
  let contractSeenAt: number | null = null;

  for (;;) {
    try {
      const contract = JSON.parse(
        fs.readFileSync(readyPath, "utf8"),
      ) as ReadyContract & { cdpPort?: number; rdpPort?: number; pid?: number };
      contractSeen = true;
      if (contractSeenAt == null) contractSeenAt = Date.now();

      /* @invariant A DEAD SESSION'S PORT IS NOBODY'S. The contract keeps the port
         of the dev server that wrote it; once that pid is gone the port may
         belong to another project's browser, and every reader that dialled it
         answered for the wrong session. */
      if (typeof contract.pid === "number" && pidState(contract.pid) !== "alive") {
        return { port: null, contractSeen };
      }

      if (typeof contract[field] === "number") {
        return { port: contract[field] as number, contractSeen };
      }
    } catch {
      if (!contractSeen) break;
    }

    const effectiveDeadline =
      contractSeenAt != null
        ? Math.min(deadline, contractSeenAt + graceMs)
        : deadline;
    if (Date.now() >= effectiveDeadline) break;

    await sleep(500);
  }

  return { port: null, contractSeen };
}

export async function resolveCdpPort(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number; graceMs?: number },
): Promise<{ port: number; source: "contract" } | null> {
  /* @invariant NO CONTRACT MEANS NO SESSION. The only port this package dials
     is the one the project's own contract names, while the process that wrote
     it is alive. */
  const { port } = await resolveContractPort(
    projectPath,
    browser,
    "cdpPort",
    options,
  );

  return port != null ? { port, source: "contract" } : null;
}

export async function resolveRdpPort(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number; graceMs?: number },
): Promise<{ port: number; source: "contract" } | null> {
  const { port } = await resolveContractPort(
    projectPath,
    browser,
    "rdpPort",
    options,
  );

  return port != null ? { port, source: "contract" } : null;
}

export const CDP_PORT_MISSING_HINT =
  "The session's ready contract has no CDP port (the browser may still be binding its debug port, or was launched without one). Confirm the session with extension_wait, give it a moment, and retry.";

export const RDP_PORT_MISSING_HINT =
  "The session's ready contract has no rdpPort. Firefox sessions publish one from extension.js 4.0.15 on; upgrade the project's extension dependency (or remove the local install so the MCP's pinned CLI drives the session) and restart the dev session.";
