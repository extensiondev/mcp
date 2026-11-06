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
import { tabsWorkers, windowStateOf } from "./tab-switch-worker";

export const FIRST_CAPTURE_MS = 4_000;

const MIN_SECOND_CAPTURE_MS = 3_000;

export type BehindWindow =
  | { tried: false }
  | { tried: true; shown: false; reason: string; windowState: string | null }
  | { tried: true; shown: true; restored: boolean; windowState: string | null };

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

/* @invariant THE BLANK TAB IS OPENED FROM THE FIRST BACKGROUND THAT HAS THE
 * TABS API, AND A BACKGROUND WITHOUT IT IS A REASON IN PLAIN WORDS, NOT A
 * THROWN MESSAGE. On a headed session the best-ranked extension background
 * answered "TypeError: Cannot read properties of undefined (reading
 * 'query')" (ledger 432): chrome.tabs was not there, the fallback died on
 * its first line, and the hint quoted the stack message as advice. The
 * script now checks for the API before it calls it, every ranked background
 * is tried in turn, and the reason names the background that lacked it. */
async function openBlankTab(
  port: number,
  workers: Array<{ targetId: string; url: string }>,
  windowId: number,
): Promise<{ worker: { targetId: string; url: string }; ids: { shownId: number | null; blankId: number } } | { reason: string }> {
  const reasons: string[] = [];

  for (const worker of workers) {
    const shown = await evaluateOnExtensionPage(
      port,
      worker.targetId,
      `(async () => { const tabs = globalThis.chrome && globalThis.chrome.tabs; if (!tabs || typeof tabs.query !== "function" || typeof tabs.create !== "function") return { noTabs: true }; const [shown] = await chrome.tabs.query({ active: true, windowId: ${windowId} }); const blank = await chrome.tabs.create({ windowId: ${windowId}, active: true, url: "about:blank", ...(shown ? { index: shown.index + 1 } : {}) }); return { shownId: shown ? shown.id : null, blankId: blank.id }; })()`,
      3_000,
    );
    const origin = worker.url.replace(/^(chrome-extension:\/\/[a-p]{32}).*$/i, "$1");

    if (!shown.ok) {
      reasons.push(`the extension background at ${origin} threw while opening a blank tab (${shown.message})`);
      continue;
    }

    const value = shown.value as { noTabs?: unknown; shownId?: unknown; blankId?: unknown } | null;

    if (value?.noTabs === true) {
      reasons.push(`the extension background at ${origin} exposes no chrome.tabs API`);
      continue;
    }

    if (!value || typeof value.blankId !== "number") {
      reasons.push(`the extension background at ${origin} opened no blank tab`);
      continue;
    }

    return { worker, ids: { shownId: typeof value.shownId === "number" ? value.shownId : null, blankId: value.blankId } };
  }

  return { reason: reasons.join("; ") || "no extension background is running in the browser to switch tabs from" };
}

/* @invariant THE WHOLE TIMEOUT IS SPENT ON THE CAPTURE, AND THE MESSAGE NAMES
 * IT. The first try is bounded to FIRST_CAPTURE_MS so a page behind other
 * windows gets the blank-tab path quickly, but when that path could not run
 * the answer used to be the first try's "timed out (4000ms)" whatever
 * timeout the call named, so the hint's "retry with a larger timeout" could
 * not be followed (ledger 437). The rest of the budget is now spent on a
 * second plain try, and a capture that still times out says the whole budget
 * and how it was split. */
function wholeBudget(outcome: CaptureOutcome, firstMs: number, restMs: number): CaptureOutcome {
  if (outcome.ok || !outcome.timedOut) return outcome;

  return { ...outcome, message: `Page.captureScreenshot did not answer within ${firstMs + restMs}ms in all (${firstMs}ms, then ${restMs}ms after this tool tried to get the page painted)` };
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

  const restMs = timeoutMs - firstMs;
  const { windowId, windowState } = await windowStateOf(port, targetId);

  const giveUp = async (reason: string): Promise<BehindWindowCapture> => {
    const again = restMs > 0 ? wholeBudget(await captureCdpTarget(port, targetId, size, restMs), firstMs, restMs) : first;

    return { outcome: again, behindWindow: { tried: true, shown: false, reason, windowState } };
  };

  if (windowId === null) return giveUp("the browser did not say which window holds the page");

  const found = await tabsWorkers(port, session.projectPath, session.browser);
  if ("reason" in found) return giveUp(found.reason);

  const opened = await openBlankTab(port, found.workers, windowId);
  if ("reason" in opened) return giveUp(opened.reason);

  const { worker, ids } = opened;

  const secondMs = Math.max(restMs, MIN_SECOND_CAPTURE_MS);
  const second = wholeBudget(await captureCdpTarget(port, targetId, size, secondMs), firstMs, secondMs);
  const shownId = ids.shownId;
  const restored = await evaluateOnExtensionPage(
    port,
    worker.targetId,
    `(async () => { ${shownId !== null ? `await chrome.tabs.update(${shownId}, { active: true }); ` : ""}await chrome.tabs.remove(${ids.blankId}); return true; })()`,
    3_000,
  );

  return { outcome: second, behindWindow: { tried: true, shown: true, restored: restored.ok, windowState } };
}
