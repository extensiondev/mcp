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
import { readWebDriverSession, readWebDriverUnavailableReason, type WebDriverSessionInfo } from "./webdriver";

import type { ReadyContract } from "./types";

export const SAFARI_SESSION_REQUEST_WAIT_MS = 70_000;

const PENDING = /^the launcher is asking safaridriver for a session now/;

export type SessionRequestOutcome =
  | { info: WebDriverSessionInfo; how: string }
  | { info: null; how: string };

function readRequestPath(projectPath: string, browser: string): string | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as ReadyContract;
    const requestPath = String(contract.webdriverRequestPath ?? "").trim();

    return requestPath.length > 0 ? requestPath : null;
  } catch {
    return null;
  }
}

export async function requestSafariWebDriverSession(
  projectPath: string,
  browser: string,
  previous: WebDriverSessionInfo | null,
  waitMs: number = SAFARI_SESSION_REQUEST_WAIT_MS,
): Promise<SessionRequestOutcome> {
  const requestPath = readRequestPath(projectPath, browser);

  if (!requestPath) {
    return { info: null, how: "ready.json names no webdriverRequestPath, so this engine cannot open a new WebDriver session on request; extension_dev with replace: true asks for a new window" };
  }

  const before = readWebDriverUnavailableReason(projectPath, browser);

  try {
    fs.writeFileSync(requestPath, JSON.stringify({ askedAt: new Date().toISOString() }));
  } catch (error) {
    return { info: null, how: `the request for a new WebDriver session could not be written to ${requestPath} (${error instanceof Error ? error.message : String(error)})` };
  }

  const started = Date.now();
  let taken = false;

  while (Date.now() - started < waitMs) {
    taken = taken || !fs.existsSync(requestPath);

    if (taken) {
      const info = readWebDriverSession(projectPath, browser);

      if (info && (info.sessionId !== previous?.sessionId || info.port !== previous?.port)) {
        return { info, how: `asked the dev run for a new WebDriver session and got ${info.sessionId} on port ${info.port}` };
      }

      const reason = readWebDriverUnavailableReason(projectPath, browser);

      if (!info && reason && !PENDING.test(reason) && (reason !== before || Date.now() - started > 1_000)) {
        return { info: null, how: `asked the dev run for a new WebDriver session and it opened none: ${reason}` };
      }
    }

    await sleep(200);
  }

  if (!taken) fs.rmSync(requestPath, { force: true });

  return {
    info: null,
    how: taken
      ? `asked the dev run for a new WebDriver session and ready.json named neither a session nor a reason ${Math.round(waitMs / 1000)} s later`
      : `asked the dev run for a new WebDriver session and it did not take the request within ${Math.round(waitMs / 1000)} s, so the dev run is not watching for one`,
  };
}
