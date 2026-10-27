// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { captureCdpTarget, type CaptureOutcome, type CaptureSize } from "./capture";
import { BACKGROUND_TARGET_TYPES, evaluateOnExtensionPage, wakeExtensionWorker } from "./cdp-extension-page";
import { sessionGuestIdentity } from "./extension-identity";

export const FIRST_CAPTURE_MS = 4_000;

const MIN_SECOND_CAPTURE_MS = 3_000;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\//i;

export type BehindWindow =
  | { tried: false }
  | { tried: true; shown: false; reason: string }
  | { tried: true; shown: true; restored: boolean };

export interface BehindWindowCapture {
  outcome: CaptureOutcome;
  behindWindow: BehindWindow;
}

export const BEHIND_WINDOW_CAPTURED =
  "The page is the shown tab of a window that sits behind other windows, which the browser does not paint, so this tool showed a blank tab in that window for the capture and then switched back; it never brought the window forward or took the keyboard.";

async function windowOf(port: number, targetId: string): Promise<number | null> {
  const cdp = new CDPClient();

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const found = (await cdp.sendCommand("Browser.getWindowForTarget", { targetId }, undefined, 3_000)) as { windowId?: unknown } | undefined;

    return typeof found?.windowId === "number" ? found.windowId : null;
  } catch {
    return null;
  } finally {
    cdp.disconnect();
  }
}

async function tabsWorker(port: number, projectPath: string, browser: string): Promise<{ targetId: string } | { reason: string }> {
  const identity = sessionGuestIdentity(projectPath, browser);
  const preferred = [...identity.expectedIds, ...identity.companionIds];
  let listed: Array<{ id: string; type: string; url: string }>;

  try {
    listed = (await CDPClient.discoverTargets(port)).map((t) => ({ id: String(t.id), type: String(t.type), url: String(t.url ?? "") }));
  } catch (error) {
    return { reason: `the browser's target list could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  const workers = listed.filter((t) => BACKGROUND_TARGET_TYPES.has(t.type) && EXTENSION_ORIGIN.test(t.url));

  const rank = (url: string): number => {
    const id = (EXTENSION_ORIGIN.exec(url)?.[1] ?? "").toLowerCase();
    const at = preferred.indexOf(id);

    return at === -1 ? preferred.length : at;
  };

  const best = workers.sort((a, b) => rank(a.url) - rank(b.url))[0];
  if (best) return { targetId: best.id };

  for (const id of identity.expectedIds) {
    const wake = await wakeExtensionWorker(port, id);
    const woken = wake.woken ? wake.targets.find((t) => BACKGROUND_TARGET_TYPES.has(t.type)) : undefined;
    if (woken) return { targetId: woken.targetId };
  }

  return { reason: "no extension background is running in the browser to switch tabs from" };
}

export async function captureCdpPage(
  port: number,
  targetId: string,
  size: CaptureSize,
  timeoutMs: number,
  session: { projectPath: string; browser: string },
): Promise<BehindWindowCapture> {
  const firstMs = Math.min(timeoutMs, FIRST_CAPTURE_MS);
  const first = await captureCdpTarget(port, targetId, size, firstMs);

  if (first.ok || !first.timedOut) return { outcome: first, behindWindow: { tried: false } };

  const windowId = await windowOf(port, targetId);
  if (windowId === null) return { outcome: first, behindWindow: { tried: true, shown: false, reason: "the browser did not say which window holds the page" } };

  const worker = await tabsWorker(port, session.projectPath, session.browser);
  if ("reason" in worker) return { outcome: first, behindWindow: { tried: true, shown: false, reason: worker.reason } };

  const shown = await evaluateOnExtensionPage(
    port,
    worker.targetId,
    `(async () => { const [shown] = await chrome.tabs.query({ active: true, windowId: ${windowId} }); const blank = await chrome.tabs.create({ windowId: ${windowId}, active: true, url: "about:blank", ...(shown ? { index: shown.index + 1 } : {}) }); return { shownId: shown ? shown.id : null, blankId: blank.id }; })()`,
    3_000,
  );
  const ids = shown.ok ? (shown.value as { shownId?: unknown; blankId?: unknown } | null) : null;

  if (!ids || typeof ids.blankId !== "number") {
    return { outcome: first, behindWindow: { tried: true, shown: false, reason: shown.ok ? "the browser opened no blank tab" : shown.message } };
  }

  const second = await captureCdpTarget(port, targetId, size, Math.max(timeoutMs - firstMs, MIN_SECOND_CAPTURE_MS));
  const shownId = typeof ids.shownId === "number" ? ids.shownId : null;
  const restored = await evaluateOnExtensionPage(
    port,
    worker.targetId,
    `(async () => { ${shownId !== null ? `await chrome.tabs.update(${shownId}, { active: true }); ` : ""}await chrome.tabs.remove(${ids.blankId}); return true; })()`,
    3_000,
  );

  return { outcome: second, behindWindow: { tried: true, shown: true, restored: restored.ok } };
}
