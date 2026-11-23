// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { pidState, processStartTicks, processStartTimes, startRecord, startedAsRecorded, type PidState, type ProcessStart } from "./process-identity";
import { findSessionInfo, recordContractPids, type ContractPidRecord } from "./process-manager";

import type { ProcessInfo, ReadyContract } from "./types";

export type ContractPidRole = "engine" | "browser" | "launcher";

type ContractPids = Pick<
  ReadyContract,
  "pid" | "pidStartedAt" | "browserPid" | "browserStartedAt" | "launcherPid" | "launcherStartedAt"
>;

const LAUNCHED: Array<Exclude<ContractPidRole, "engine">> = ["browser", "launcher"];

function positivePid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function contractPid(contract: ContractPids | null | undefined, role: ContractPidRole): number | null {
  if (!contract) return null;

  return positivePid(role === "engine" ? contract.pid : role === "browser" ? contract.browserPid : contract.launcherPid);
}

function contractStamp(contract: ContractPids, role: ContractPidRole): string | null {
  const stamp: unknown =
    role === "engine" ? contract.pidStartedAt : role === "browser" ? contract.browserStartedAt : contract.launcherStartedAt;

  return typeof stamp === "string" && Number.isFinite(Date.parse(stamp)) ? stamp : null;
}

function recordedStamp(session: ProcessInfo, role: Exclude<ContractPidRole, "engine">, pid: number): string | null {
  const recordedPid = role === "browser" ? session.browserPid : session.launcherPid;
  const recordedAt = role === "browser" ? session.browserStartedAt : session.launcherStartedAt;

  return recordedPid === pid && typeof recordedAt === "string" ? recordedAt : null;
}

function stampLaunched(projectPath: string, browser: string, session: ProcessInfo, contract: ContractPids): ContractPidRecord {
  const unstamped = LAUNCHED.map((role) => ({ role, pid: contractPid(contract, role) })).filter(
    (entry): entry is { role: Exclude<ContractPidRole, "engine">; pid: number } =>
      entry.pid !== null && contractStamp(contract, entry.role) === null && recordedStamp(session, entry.role, entry.pid) === null,
  );
  if (unstamped.length === 0) return {};

  const times = processStartTimes(unstamped.map((entry) => entry.pid));
  const record: ContractPidRecord = {};

  for (const { role, pid } of unstamped) {
    const startedAt = times.get(pid);
    if (!startedAt) continue;

    const { startTicks } = startRecord(startedAt, processStartTicks(pid));

    Object.assign(
      record,
      role === "browser" ? { browserPid: pid, browserStartedAt: startedAt } : { launcherPid: pid, launcherStartedAt: startedAt },
      startTicks === undefined ? {} : role === "browser" ? { browserStartTicks: startTicks } : { launcherStartTicks: startTicks },
    );
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

  const dated = contractStamp(contract, role);
  if (dated !== null) return dated;

  const session = findSessionInfo(projectPath, browser);
  if (!session) return null;

  if (role === "engine") return session.pid === pid ? (session.processStartedAt ?? null) : null;

  const recorded = recordedStamp(session, role, pid);
  if (recorded !== null) return recorded;

  const stamped = stampLaunched(projectPath, browser, session, contract);

  return (role === "browser" ? stamped.browserStartedAt : stamped.launcherStartedAt) ?? null;
}

/* @invariant A CONTRACT PID GETS ITS CLOCK TICKS THE FIRST TIME IT IS SEEN
 * ALIVE. The engine stamps its contract with wall-clock start times only, so
 * a step of the wall clock on Linux would read the session's browser as
 * ended (ledger 1022 d). The first read that finds the PID started when the
 * contract or the session record says writes its ticks since boot into the
 * session record, and every later read is decided by those. The engine's
 * own PID carries the ticks taken when the session was registered.
 */
function contractPidStartTicks(
  projectPath: string,
  browser: string,
  role: ContractPidRole,
  pid: number,
  startedAt: string | null,
): number | undefined {
  const session = findSessionInfo(projectPath, browser);
  if (!session) return undefined;

  if (role === "engine") return session.pid === pid ? session.processStartTicks : undefined;

  const recordedPid = role === "browser" ? session.browserPid : session.launcherPid;
  const recorded = role === "browser" ? session.browserStartTicks : session.launcherStartTicks;
  if (recordedPid === pid && typeof recorded === "number") return recorded;

  if (startedAt === null) return undefined;

  const ticks = processStartTicks(pid);
  if (ticks === null || !startedAsRecorded(pid, startedAt)) return undefined;

  const stamp = recordedPid === pid ? {} : role === "browser" ? { browserStartedAt: startedAt } : { launcherStartedAt: startedAt };

  recordContractPids(
    projectPath,
    browser,
    role === "browser" ? { browserPid: pid, ...stamp, browserStartTicks: ticks } : { launcherPid: pid, ...stamp, launcherStartTicks: ticks },
  );

  return ticks;
}

export function contractPidStart(
  projectPath: string,
  browser: string,
  contract: ContractPids | null | undefined,
  role: ContractPidRole,
): ProcessStart | null {
  const pid = contractPid(contract, role);
  if (pid === null || !contract) return null;

  const startedAt = contractPidStartedAt(projectPath, browser, contract, role);

  return startRecord(startedAt, contractPidStartTicks(projectPath, browser, role, pid, startedAt));
}

export function contractPidState(
  projectPath: string,
  browser: string,
  contract: ContractPids | null | undefined,
  role: ContractPidRole,
): PidState | null {
  const pid = contractPid(contract, role);
  if (pid === null) return null;

  return pidState(pid, contractPidStart(projectPath, browser, contract, role));
}
