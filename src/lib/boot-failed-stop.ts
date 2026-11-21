// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { stopOne } from "../tools/stop";

const DEAD_CONTRACT_CODES = new Set(["browser_exited", "browser_launch_failed", "compile_failed"]);

export function isDeadContractCode(contractCode: unknown, session: "dev" | "start" | "preview" = "dev"): boolean {
  if (session !== "dev" && contractCode === "compile_error") return true;

  return typeof contractCode === "string" && DEAD_CONTRACT_CODES.has(contractCode);
}

export interface FailedBootStop {
  sessionStopped: boolean;
  stopDetail?: string;
}

export async function stopFailedBoot(
  projectPath: string,
  browser: string,
): Promise<FailedBootStop> {
  const outcome = await stopOne(projectPath, browser);
  const sessionStopped = outcome.stopped || outcome.serverGone === true;

  return sessionStopped ? { sessionStopped } : { sessionStopped, stopDetail: outcome.detail };
}
