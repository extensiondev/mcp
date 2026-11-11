// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { evaluateOnExtensionPage } from "./cdp-extension-page";
import { tabsWorker } from "./tab-switch-worker";

export const MENU_REPLAY_TIMEOUT_MS = 10_000;

export interface ReplayedTab {
  id?: number;
  url?: string;
  title?: string;
  windowId?: number;
}

export type MenuReplayOutcome =
  | { kind: "replayed"; tab: ReplayedTab | null; info: Record<string, unknown>; worker: string }
  | { kind: "no-api" }
  | { kind: "no-listener" }
  | { kind: "no-dispatch" }
  | { kind: "no-tab"; message: string }
  | { kind: "no-background"; reason: string }
  | { kind: "failed"; message: string; timedOut: boolean };

export function contextMenuClickScript(menuItemId: string, tabId: number | null): string {
  const pickTab =
    tabId === null
      ? "(await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || (await chrome.tabs.query({ active: true }))[0] || null"
      : `await chrome.tabs.get(${tabId})`;

  return `(async () => {
  var api = typeof chrome !== "undefined" && chrome.contextMenus;
  if (!api || !api.onClicked) return { outcome: "no-api" };
  var event = api.onClicked;
  if (typeof event.hasListeners === "function" && !event.hasListeners()) return { outcome: "no-listener" };
  if (typeof event.dispatch !== "function") return { outcome: "no-dispatch" };
  var tab = null;
  try { tab = ${pickTab}; } catch (e) { return { outcome: "no-tab", message: String((e && e.message) || e) }; }
  var info = { menuItemId: ${JSON.stringify(menuItemId)}, editable: false };
  if (tab && tab.url) info.pageUrl = tab.url;
  event.dispatch(info, tab || undefined);
  return { outcome: "dispatched", info: info, tab: tab ? { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId } : null };
})()`;
}

type ScriptAnswer = { outcome?: unknown; message?: unknown; tab?: unknown; info?: unknown };

export async function replayContextMenuClick(
  port: number,
  session: { projectPath: string; browser: string },
  menuItemId: string,
  tabId: number | null,
  timeoutMs: number | undefined,
): Promise<MenuReplayOutcome> {
  const worker = await tabsWorker(port, session.projectPath, session.browser);
  if ("reason" in worker) return { kind: "no-background", reason: worker.reason };

  const ran = await evaluateOnExtensionPage(port, worker.targetId, contextMenuClickScript(menuItemId, tabId), timeoutMs ?? MENU_REPLAY_TIMEOUT_MS);
  if (!ran.ok) return { kind: "failed", message: ran.message, timedOut: "timedOut" in ran && ran.timedOut === true };

  const answer = (ran.value && typeof ran.value === "object" ? ran.value : {}) as ScriptAnswer;

  switch (answer.outcome) {
    case "dispatched":
      return {
        kind: "replayed",
        tab: answer.tab && typeof answer.tab === "object" ? (answer.tab as ReplayedTab) : null,
        info: answer.info && typeof answer.info === "object" ? (answer.info as Record<string, unknown>) : { menuItemId, editable: false },
        worker: worker.targetId,
      };
    case "no-api":
      return { kind: "no-api" };
    case "no-listener":
      return { kind: "no-listener" };
    case "no-dispatch":
      return { kind: "no-dispatch" };
    case "no-tab":
      return { kind: "no-tab", message: String(answer.message ?? "the tab could not be read") };
    default:
      return { kind: "failed", message: `the service worker answered no replay outcome (${JSON.stringify(ran.value).slice(0, 200)})`, timedOut: false };
  }
}
