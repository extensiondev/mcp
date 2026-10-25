// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { envelope } from "./envelope";
import { liveProjectSessions } from "./session-browser";
import { readyContractPath } from "./session-paths";
import { stopOne } from "../tools/stop";

export type ReplacedSession = { pid: number; browser: string; controlPort?: number };

export type SameBrowserGuard =
  | { refusal: string }
  | { replaced: ReplacedSession[] };

function contractControlPort(projectPath: string, browser: string): number | null {
  try {
    const port = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8"))?.controlPort;

    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}

export async function guardSameBrowserSession(input: {
  tool: string;
  projectPath: string;
  browser: string;
  replace: boolean | undefined;
  hazard: string;
  replacing: string;
}): Promise<SameBrowserGuard> {
  const { tool, projectPath, browser } = input;
  const existing = liveProjectSessions(projectPath).filter((s) => s.browser === browser);
  const replaced: ReplacedSession[] = [];

  if (existing.length > 0 && !input.replace) {
    const listed = existing.map((s) => `pid ${s.pid} (${s.browser})`).join(", ");

    return {
      refusal: envelope({
        ok: false,
        command: tool,
        status: "session-exists",
        error: {
          code: "E_SESSION_EXISTS",
          message:
            `A ${browser} session is already running for this project (${listed}). ` +
            `It owns dist/${browser} and the ready.json and eval token under dist/extension-js/${browser}/, so ${input.hazard} A session for another browser can run beside it.`,
        },
        value: {
          projectPath,
          sessions: existing.map((s) => ({ pid: s.pid, browser: s.browser })),
        },
        hint: `Call extension_stop with this projectPath and browser: "${browser}" first, or pass replace: true to have ${tool} stop that session before starting ${input.replacing}.`,
      }),
    };
  }

  for (const s of existing) {
    const controlPort = contractControlPort(projectPath, s.browser);
    const outcome = await stopOne(projectPath, s.browser);

    if (!outcome.stopped && !outcome.staleRecord) {
      return {
        refusal: envelope({
          ok: false,
          command: tool,
          status: "replace-failed",
          error: {
            code: "E_SESSION_EXISTS",
            message: `replace: true could not stop the ${s.browser} session (pid ${s.pid}): ${outcome.detail} No new session was started.`,
          },
          value: {
            projectPath,
            session: { pid: s.pid, browser: s.browser },
            reaped: outcome.reaped,
          },
          hint: `Call extension_stop for this projectPath and read its detail; if a browser process survives, end it by pid, then call ${tool} again.`,
        }),
      };
    }

    if (!outcome.staleRecord) replaced.push({ pid: s.pid, browser: s.browser, ...(controlPort !== null ? { controlPort } : {}) });
  }

  return { replaced };
}
