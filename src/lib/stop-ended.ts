// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { contractPid } from "./contract-pids";
import { pidState } from "./process-identity";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export interface EndedProcesses {
  serverGone: boolean | null;
  browserPid: number | null;
  browserGone: boolean | null;
}

export function readReadyContract(projectPath: string, browser: string): ReadyContract | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as unknown;

    return contract && typeof contract === "object" ? (contract as ReadyContract) : null;
  } catch {
    return null;
  }
}

export function contractBrowserPid(projectPath: string, browser: string): number | null {
  return contractPid(readReadyContract(projectPath, browser), "browser");
}

export function endedProcesses(
  serverGone: boolean | null,
  browserPid: number | null,
  browserStartedAt: string | null = null,
): EndedProcesses {
  return {
    serverGone,
    browserPid,
    browserGone: browserPid === null ? null : pidState(browserPid, browserStartedAt) !== "alive",
  };
}

export function describeEnded(
  ended: EndedProcesses,
  serverPid: number | null,
  noBrowser: boolean,
): string {
  const server =
    serverPid === null || ended.serverGone === null
      ? "no server pid was on record"
      : `the server (pid ${serverPid}) is ${ended.serverGone ? "gone" : "still alive"}`;
  const browser =
    ended.browserPid === null
      ? noBrowser
        ? "no browser was launched (build-only session), so there is none to close"
        : "the contract recorded no browser pid, so the browser's own state was not read here; survivors were searched by profile path and argv instead"
      : `the browser the launcher recorded (pid ${ended.browserPid}) is ${ended.browserGone ? "gone" : "still alive"}`;

  return `Ended: ${server}; ${browser}.`;
}
