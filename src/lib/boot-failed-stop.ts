// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { stopOne } from "../tools/stop";

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
