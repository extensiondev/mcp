// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { pidState } from "./process-identity";
import { findSessionInfo } from "./process-manager";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export type ProductionPhase = "starting" | "ready" | "error" | "stopped" | "engine-gone";

export interface ProductionReceipt {
  kind: "production";
  path: string;
  contract: ReadyContract;
  verb: "start" | "preview";
  control: boolean;
  controlRequested: boolean | null;
  controlPort: number | null;
  cdpPort: number | null;
  attachedAt: string | null;
  phase: ProductionPhase;
}

export type SessionReceipt =
  | { kind: "none"; path: string }
  | { kind: "dev"; path: string; contract: ReadyContract }
  | { kind: "build"; path: string; contract: ReadyContract }
  | ProductionReceipt;

function port(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function phaseOf(contract: ReadyContract): ProductionPhase {
  if (typeof contract.pid === "number" && pidState(contract.pid) !== "alive") return "engine-gone";
  if (contract.status === "error") return "error";
  if (contract.status === "stopped") return "stopped";

  return contract.status === "ready" ? "ready" : "starting";
}

function controlRequestedAtLaunch(projectPath: string, browser: string, contract: ReadyContract): boolean | null {
  const registered = findSessionInfo(projectPath, browser);

  if (!registered || typeof registered.allowControl !== "boolean") return null;
  if (typeof contract.pid === "number" && registered.pid !== contract.pid) return null;

  return registered.allowControl;
}

export function readSessionReceipt(projectPath: string, browser: string): SessionReceipt {
  const path = readyContractPath(projectPath, browser);
  let contract: ReadyContract;

  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { kind: "none", path };

    contract = parsed as ReadyContract;
  } catch {
    return { kind: "none", path };
  }

  if (contract.command === "build") return { kind: "build", path, contract };
  if (contract.command !== "start" && contract.command !== "preview") return { kind: "dev", path, contract };

  const controlPort = port(contract.controlPort);

  return {
    kind: "production",
    path,
    contract,
    verb: contract.command,
    control: controlPort !== null,
    controlRequested: controlRequestedAtLaunch(projectPath, browser, contract),
    controlPort,
    cdpPort: port(contract.cdpPort),
    attachedAt: typeof contract.executorAttachedAt === "string" && contract.executorAttachedAt ? contract.executorAttachedAt : null,
    phase: phaseOf(contract),
  };
}

export function waitCall(projectPath: string, browser: string): string {
  return `extension_wait {projectPath: ${JSON.stringify(projectPath)}, browser: ${JSON.stringify(browser)}}`;
}
