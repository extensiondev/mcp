// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { captureCdpTarget, type CaptureOutcome, type CaptureSize } from "./capture";
import { evaluateOnExtensionPage } from "./cdp-extension-page";
import { showHiddenTab, type HiddenTab } from "./capture-hidden-tab";
import { tabsWorker, windowOf } from "./tab-switch-worker";

export const FIRST_CAPTURE_MS = 4_000;

const MIN_SECOND_CAPTURE_MS = 3_000;

export type BehindWindow =
  | { tried: false }
  | { tried: true; shown: false; reason: string }
  | { tried: true; shown: true; restored: boolean };

export interface BehindWindowCapture {
  outcome: CaptureOutcome;
  behindWindow: BehindWindow;
  hiddenTab?: HiddenTab;
}

export const BEHIND_WINDOW_CAPTURED =
  "The page is the shown tab of a window that sits behind other windows, which the browser does not paint, so this tool showed a blank tab in that window for the capture and then switched back; it never brought the window forward or took the keyboard.";

export async function captureCdpPage(
  port: number,
  targetId: string,
  size: CaptureSize,
  timeoutMs: number,
  session: { projectPath: string; browser: string },
): Promise<BehindWindowCapture> {
  const hidden = await showHiddenTab(port, targetId, session);
  const capture = await capturePaintedPage(port, targetId, size, timeoutMs, session);

  return { ...capture, hiddenTab: await hidden.restore() };
}

async function capturePaintedPage(
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
