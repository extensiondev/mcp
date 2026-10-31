// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { evaluateOnExtensionPage } from "./cdp-extension-page";
import { tabsWorker, windowOf } from "./tab-switch-worker";

export const ANIMATION_SETTLE_MS = 2_000;

export type HiddenTab =
  | { hidden: true; shown: false; reason: string }
  | { hidden: true; shown: true; restored: boolean; animationsFinished: boolean };

export interface HiddenTabShowing {
  restore: () => Promise<HiddenTab | undefined>;
}

export const SETTLE_ANIMATIONS_SCRIPT =
  "(async () => { const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await frame(); " +
  "const ends = document.getAnimations().filter((a) => a.playState === \"running\" && Number.isFinite(a.effect && a.effect.getComputedTiming().endTime)).map((a) => a.finished.then(() => true, () => true)); " +
  `const finished = await Promise.race([Promise.all(ends).then(() => true), new Promise((r) => setTimeout(() => r(false), ${ANIMATION_SETTLE_MS}))]); await frame(); return finished; })()`;

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function done(state?: HiddenTab): HiddenTabShowing {
  return { restore: async () => state };
}

async function targetUrl(port: number, targetId: string): Promise<string | null> {
  try {
    const found = (await CDPClient.discoverTargets(port)).find((t) => String(t.id) === targetId);

    return found ? String(found.url ?? "") : null;
  } catch {
    return null;
  }
}

function showScript(windowId: number, url: string): string {
  return `(async () => { const [shown] = await chrome.tabs.query({ active: true, windowId: ${windowId} }); const matches = (await chrome.tabs.query({ windowId: ${windowId} })).filter((t) => t.url === ${JSON.stringify(url)}); if (matches.length !== 1) return { matched: matches.length, readable: matches.length > 0 || (shown ? typeof shown.url === "string" : true) }; await chrome.tabs.update(matches[0].id, { active: true }); return { matched: 1, shownId: shown ? shown.id : null }; })()`;
}

function unmatched(found: { matched?: unknown; readable?: unknown }, url: string): string {
  if (found.readable === false) return "the extension cannot read tab urls (no \"tabs\" permission in this build), so this tool could not tell which tab of the window holds the page";

  return found.matched === 0
    ? `no tab of the page's window reports ${url}`
    : `${String(found.matched)} tabs of the page's window show ${url}, so this tool could not tell which one to show`;
}

export async function showHiddenTab(
  port: number,
  targetId: string,
  session: { projectPath: string; browser: string },
): Promise<HiddenTabShowing> {
  const visibility = await evaluateOnExtensionPage(port, targetId, "document.visibilityState", 2_000);
  if (!visibility.ok || visibility.value !== "hidden") return done();

  const refused = (reason: string) => done({ hidden: true, shown: false, reason });
  const url = await targetUrl(port, targetId);
  if (!url) return refused("the browser's target list did not name the page's url");

  const windowId = await windowOf(port, targetId);
  if (windowId === null) return refused("the browser did not say which window holds the page");

  const worker = await tabsWorker(port, session.projectPath, session.browser);
  if ("reason" in worker) return refused(worker.reason);

  const shown = await evaluateOnExtensionPage(port, worker.targetId, showScript(windowId, url), 3_000);
  if (!shown.ok) return refused(`the extension background could not switch tabs: ${shown.message}`);

  const found = (shown.value ?? {}) as { matched?: unknown; readable?: unknown; shownId?: unknown };
  if (found.matched !== 1) return refused(unmatched(found, url));

  const settled = await evaluateOnExtensionPage(port, targetId, SETTLE_ANIMATIONS_SCRIPT, ANIMATION_SETTLE_MS + 2_000);
  const animationsFinished = settled.ok && settled.value === true;
  const shownId = typeof found.shownId === "number" ? found.shownId : null;

  return {
    restore: async () => {
      if (shownId === null) return { hidden: true, shown: true, restored: true, animationsFinished };

      const back = await evaluateOnExtensionPage(
        port,
        worker.targetId,
        `(async () => { await chrome.tabs.update(${shownId}, { active: true }); return true; })()`,
        3_000,
      ).catch((error: unknown) => ({ ok: false as const, message: said(error) }));

      return { hidden: true, shown: true, restored: back.ok, animationsFinished };
    },
  };
}

export function hiddenTabSentence(state: HiddenTab | undefined): string | null {
  if (!state) return null;

  if (!state.shown) {
    return `The page is a hidden tab (document.visibilityState "hidden"), where the browser pauses CSS animations, requestAnimationFrame and timers, so the image may show a mid-animation state; this tool could not show it for the capture (${state.reason}). Open it with extension_open foreground: true and capture again.`;
  }

  return `The page was a hidden tab, where the browser pauses CSS animations, requestAnimationFrame and timers, so this tool made it the shown tab of its window for the capture, ${
    state.animationsFinished ? "let its running animations finish" : `waited ${ANIMATION_SETTLE_MS} ms for its running animations (some were still running)`
  }, and ${state.restored ? "switched back" : "could NOT switch back to the tab shown before"}; it never brought the window forward or took the keyboard.`;
}
