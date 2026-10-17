// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isChromiumFamily, isGeckoFamily, WEBKIT_FAMILY } from "./browser-family";
import { pidState } from "./process-identity";
import { envelope, sessionCommandSinceEnvelopeOwnsCommand } from "./envelope";
import {
  WebDriverClient,
  webdriverSessionEndedHint,
  webdriverSessionEndedMessage,
  type WebDriverSessionInfo,
} from "./webdriver";

import type { ReadyContract } from "./types";

export type DetachedVerdict =
  | { kind: "asleep"; evidence: string }
  | { kind: "webdriver-ended"; info: WebDriverSessionInfo }
  | { kind: "gone"; evidence: string | null };

function recordedWebDriver(contract: ReadyContract): WebDriverSessionInfo | null {
  if (!WEBKIT_FAMILY.has(contract.browser)) return null;

  const port = contract.webdriverPort;
  const sessionId = contract.webdriverSessionId;

  return typeof port === "number" && typeof sessionId === "string" && sessionId
    ? { port, sessionId }
    : null;
}

export async function readDetachedVerdict(contract: ReadyContract): Promise<DetachedVerdict> {
  const info = recordedWebDriver(contract);

  if (info) {
    const driver = await new WebDriverClient(info).liveness();

    if (driver === "session-ended") return { kind: "webdriver-ended", info };

    return driver === "alive"
      ? { kind: "asleep", evidence: `the dev session's WebDriver session ${info.sessionId} on port ${info.port} answered, so Safari is running` }
      : { kind: "gone", evidence: `the dev session's safaridriver on port ${info.port} no longer answers` };
  }

  const pid = typeof contract.browserPid === "number" && contract.browserPid > 0 ? contract.browserPid : null;

  if (pid === null || pidState(pid) !== "alive") {
    return { kind: "gone", evidence: pid === null ? null : `the browser pid the launcher recorded (${pid}) is gone` };
  }

  if (typeof contract.browserExitedAt !== "string") {
    return { kind: "asleep", evidence: `the browser pid the launcher recorded (${pid}) is alive` };
  }

  return isGeckoFamily(contract.browser)
    ? {
        kind: "asleep",
        evidence: `the browser pid the launcher recorded (${pid}) is alive, so the exit stamped at ${contract.browserExitedAt} was an earlier process: Firefox hands a fresh profile to a relaunched process and the first one exits 0`,
      }
    : { kind: "gone", evidence: null };
}

function suspendRule(browser: string): string {
  if (isChromiumFamily(browser)) return "Chrome stops an idle MV3 service worker after 30 s";
  if (isGeckoFamily(browser)) return "Firefox suspends a non-persistent background after 30 s idle";

  return "Safari suspends a non-persistent background after 30 s idle";
}

function backgroundAsleepMessage(
  contract: ReadyContract,
  evidence: string,
): string {
  return `The browser is running (${evidence}), and the extension's background is asleep: its executor detached${contract.executorDetachedAt ? ` at ${contract.executorDetachedAt}` : ""} because ${suspendRule(contract.browser)}. That is not a crash and the session needs no restart.`;
}

function backgroundAsleepHint(browser: string): string {
  const reload = isGeckoFamily(browser) || isChromiumFamily(browser)
    ? ", or call extension_reload, which starts a fresh background"
    : "";

  return `Wake it with an event it listens to: load or reload a page its content script matches (extension_open with that url), click its toolbar button, or send it a message from a page${reload}. When it connects, ready.json stamps the executor attached again and extension_wait answers ready; until then extension_storage and extension_eval context "background" have nothing to reach, while extension_logs keeps reading the session log.`;
}

export function detachedVerdictFrame(
  command: string,
  contract: ReadyContract,
  verdict: Exclude<DetachedVerdict, { kind: "gone" }>,
  extra: Record<string, unknown>,
  clampNote: string | null,
): string {
  const base = {
    compiled: true,
    browserAttached: false,
    ...sessionCommandSinceEnvelopeOwnsCommand(contract),
    browser: contract.browser,
    pid: contract.pid,
  };

  if (verdict.kind === "asleep") {
    return envelope({
      ok: true,
      command,
      status: "background-asleep",
      value: {
        ...base,
        backgroundAsleep: true,
        ...(typeof contract.browserPid === "number" ? { browserPid: contract.browserPid } : {}),
        executorAttachedAt: contract.executorAttachedAt,
        executorDetachedAt: contract.executorDetachedAt,
        ...extra,
      },
      warnings: [backgroundAsleepMessage(contract, verdict.evidence), clampNote],
      hint: backgroundAsleepHint(contract.browser),
    });
  }

  return envelope({
    ok: false,
    command,
    status: "webdriver-session-ended",
    error: {
      code: "E_WEBDRIVER_SESSION_ENDED",
      message: `${webdriverSessionEndedMessage(verdict.info, contract.browser)} The extension's executor also detached${contract.executorDetachedAt ? ` at ${contract.executorDetachedAt}` : ""}, which by itself is the background going idle.`,
    },
    value: {
      ...base,
      webdriverPort: verdict.info.port,
      webdriverSessionId: verdict.info.sessionId,
      ...extra,
    },
    hint: webdriverSessionEndedHint(contract.browser),
  });
}
