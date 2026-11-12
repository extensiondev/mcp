// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { pidState, processStartTimes, type PidState } from "./process-identity";
import { findSessionInfo, recordContractPids, type ContractPidRecord } from "./process-manager";

import type { ProcessInfo, ReadyContract } from "./types";

export type ContractPidRole = "engine" | "browser" | "launcher";

type ContractPids = Pick<ReadyContract, "pid" | "browserPid" | "launcherPid">;

const LAUNCHED: Array<Exclude<ContractPidRole, "engine">> = ["browser", "launcher"];

function positivePid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function contractPid(contract: ContractPids | null | undefined, role: ContractPidRole): number | null {
  if (!contract) return null;

  return positivePid(role === "engine" ? contract.pid : role === "browser" ? contract.browserPid : contract.launcherPid);
}

function recordedStamp(session: ProcessInfo, role: Exclude<ContractPidRole, "engine">, pid: number): string | null {
  const recordedPid = role === "browser" ? session.browserPid : session.launcherPid;
  const recordedAt = role === "browser" ? session.browserStartedAt : session.launcherStartedAt;

  return recordedPid === pid && typeof recordedAt === "string" ? recordedAt : null;
}

function stampLaunched(projectPath: string, browser: string, session: ProcessInfo, contract: ContractPids): ContractPidRecord {
  const unstamped = LAUNCHED.map((role) => ({ role, pid: contractPid(contract, role) })).filter(
    (entry): entry is { role: Exclude<ContractPidRole, "engine">; pid: number } =>
      entry.pid !== null && recordedStamp(session, entry.role, entry.pid) === null,
  );
  if (unstamped.length === 0) return {};

  const times = processStartTimes(unstamped.map((entry) => entry.pid));
  const record: ContractPidRecord = {};

  for (const { role, pid } of unstamped) {
    const startedAt = times.get(pid);
    if (!startedAt) continue;

    Object.assign(record, role === "browser" ? { browserPid: pid, browserStartedAt: startedAt } : { launcherPid: pid, launcherStartedAt: startedAt });
  }

  if (Object.keys(record).length > 0) recordContractPids(projectPath, browser, record);

  return record;
}

export function contractPidStartedAt(
  projectPath: string,
  browser: string,
  contract: ContractPids | null | undefined,
  role: ContractPidRole,
): string | null {
  const pid = contractPid(contract, role);
  if (pid === null || !contract) return null;

  const session = findSessionInfo(projectPath, browser);
  if (!session) return null;

  if (role === "engine") return session.pid === pid ? (session.processStartedAt ?? null) : null;

  const recorded = recordedStamp(session, role, pid);
  if (recorded !== null) return recorded;

  const stamped = stampLaunched(projectPath, browser, session, contract);

  return (role === "browser" ? stamped.browserStartedAt : stamped.launcherStartedAt) ?? null;
}

export function contractPidState(
  projectPath: string,
  browser: string,
  contract: ContractPids | null | undefined,
  role: ContractPidRole,
): PidState | null {
  const pid = contractPid(contract, role);
  if (pid === null) return null;

  return pidState(pid, contractPidStartedAt(projectPath, browser, contract, role));
}
