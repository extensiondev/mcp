// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { CDPClient } from "./cdp";

const FOREGROUND_COMMAND_MS = 3_000;

export interface Foreground {
  requested: true;
  activated: boolean;
  windowRaised: boolean;
  reason?: string;
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

  return foreground.windowRaised
    ? "The tab was brought forward as asked: it is the active tab and its browser window was raised in front of the person's other windows, so they can act on it now. Tell them it is waiting for them."
    : `The tab is the active tab of its window, but the window was not raised (${foreground.reason ?? "the browser did not say why"}), so it may sit behind other windows: tell the person which browser window to look at.`;
}
