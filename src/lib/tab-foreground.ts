// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { readFrontmostApp } from "./frontmost-window";
import { readyContractPath } from "./session-paths";

import type { CDPClient } from "./cdp";

const FOREGROUND_COMMAND_MS = 3_000;

const CHROMIUM_APP = /chrome|chromium|edge|brave|opera|vivaldi|yandex|arc/i;

export type WindowRaised = boolean | "unconfirmed";

export interface Foreground {
  requested: true;
  activated: boolean;
  windowRaised: WindowRaised;
  reason?: string;
  frontmost?: { app: string; pid: number | null };
}

export function sessionBrowserPid(projectPath: string, browser: string): number | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as { browserPid?: unknown };

    return typeof contract.browserPid === "number" && contract.browserPid > 0 ? contract.browserPid : null;
  } catch {
    return null;
  }
}

const withReason = (foreground: Foreground, reason: string): string => (foreground.reason ? `${foreground.reason}; ${reason}` : reason);

export function confirmWindowRaised(foreground: Foreground, context: { headless: boolean; browserPid: number | null }): Foreground {
  if (foreground.windowRaised !== true) return foreground;

  if (context.headless) {
    return { ...foreground, windowRaised: false, reason: withReason(foreground, "the session is headless, so there is no window to raise") };
  }

  const read = readFrontmostApp();

  if ("unavailable" in read) {
    return { ...foreground, windowRaised: "unconfirmed", reason: withReason(foreground, `the browser answered the raise, but ${read.unavailable}`) };
  }

  const named = `${read.app}${read.pid !== null ? ` (pid ${read.pid})` : ""}`;

  if (context.browserPid === null) {
    if (CHROMIUM_APP.test(read.app)) return foreground;

    return { ...foreground, windowRaised: false, frontmost: read, reason: withReason(foreground, `the browser answered the raise, but the frontmost app afterward is ${named}, not the dev browser`) };
  }

  if (read.pid === context.browserPid) return foreground;

  if (CHROMIUM_APP.test(read.app)) {
    return {
      ...foreground,
      windowRaised: "unconfirmed",
      frontmost: read,
      reason: withReason(foreground, `the browser answered the raise, but the frontmost app afterward is ${named}, which is not the dev browser's process (pid ${context.browserPid}), so it may be another window of the same browser`),
    };
  }

  return {
    ...foreground,
    windowRaised: false,
    frontmost: read,
    reason: withReason(foreground, `the browser answered the raise, but the frontmost app afterward is ${named}, not the dev browser (pid ${context.browserPid})`),
  };
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function bringTabForward(
  cdp: Pick<CDPClient, "sendCommand" | "attachToTarget">,
  targetId: string,
): Promise<Foreground> {
  const reasons: string[] = [];
  let activated = false;
  let windowRaised = false;

  try {
    await cdp.sendCommand("Target.activateTarget", { targetId }, undefined, FOREGROUND_COMMAND_MS);
    activated = true;
  } catch (error) {
    reasons.push(`Target.activateTarget refused: ${said(error)}`);
  }

  try {
    const sessionId = await cdp.attachToTarget(targetId);
    await cdp.sendCommand("Page.bringToFront", {}, sessionId, FOREGROUND_COMMAND_MS);
    windowRaised = true;
    activated = true;
  } catch (error) {
    reasons.push(`Page.bringToFront refused: ${said(error)}`);
  }

  return {
    requested: true,
    activated,
    windowRaised,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

export function foregroundUnsupported(reason: string): Foreground {
  return { requested: true, activated: false, windowRaised: false, reason };
}

export function foregroundSentence(foreground: Foreground, headless: boolean): string {
  if (!foreground.activated) {
    return `The tab was NOT brought forward (${foreground.reason ?? "the browser did not say why"}), so the person may not see it: ask them to switch to it in the dev browser.`;
  }

  if (headless) {
    return "The tab was made the active tab of its window as asked, but this session is headless, so no one can see it: for a page the person must act on, call extension_dev again with headless: false and replace: true, then open it again with foreground: true.";
  }

  if (foreground.windowRaised === true) {
    return "The tab was brought forward as asked: it is the active tab and its browser window was raised in front of the person's other windows, so they can act on it now. Tell them it is waiting for them.";
  }

  if (foreground.windowRaised === "unconfirmed") {
    return `The tab is the active tab of its window and the browser answered the raise, but this server could not confirm the window is frontmost (${foreground.reason ?? "the OS did not say what is in front"}), so the person may need to bring the dev browser window to the front themselves: tell them which window to look for.`;
  }

  return `The tab is the active tab of its window, but the window was not raised (${foreground.reason ?? "the browser did not say why"}), so it sits behind other windows: ask the person to bring the dev browser window to the front and tell them which window to look at.`;
}
