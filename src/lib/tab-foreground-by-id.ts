// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { actFrameJson, addWarning, patchValue } from "./act";
import { evaluateOnExtensionPage } from "./cdp-extension-page";
import { resolveCdpPort } from "./cdp-port";
import { parseFrameObject } from "./frame-json";
import { foregroundSentence, foregroundUnsupported, type Foreground } from "./tab-foreground";
import { tabViewFields, tabViewSentence } from "./tab-view";
import { tabsWorker } from "./tab-switch-worker";

export function activateTabScript(tabId: number): string {
  return `(async () => { const tab = await chrome.tabs.update(${tabId}, { active: true }); let windowRaised = false; let refused = null; try { await chrome.windows.update(tab.windowId, { focused: true }); windowRaised = true; } catch (e) { refused = String((e && e.message) || e); } return { active: tab.active === true, windowRaised, refused }; })()`;
}

export async function bringTabIdForward(
  port: number,
  tabId: number,
  session: { projectPath: string; browser: string },
): Promise<Foreground> {
  const worker = await tabsWorker(port, session.projectPath, session.browser);
  if ("reason" in worker) return foregroundUnsupported(`tab ${tabId} was navigated, but ${worker.reason}`);

  const ran = await evaluateOnExtensionPage(port, worker.targetId, activateTabScript(tabId), 3_000);
  if (!ran.ok) return foregroundUnsupported(`chrome.tabs.update(${tabId}, { active: true }) refused: ${ran.message}`);

  const read = (ran.value ?? {}) as { active?: unknown; windowRaised?: unknown; refused?: unknown };
  const activated = read.active === true;
  const windowRaised = read.windowRaised === true;
  const reasons = [
    activated ? null : `chrome.tabs.update(${tabId}, { active: true }) did not make it the active tab`,
    windowRaised || typeof read.refused !== "string" ? null : `chrome.windows.update refused: ${read.refused}`,
  ].filter((reason): reason is string => reason !== null);

  return { requested: true, activated, windowRaised, ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}) };
}

export async function withNavigatedTabForward(
  raw: string,
  session: { projectPath: string; browser: string; headless: boolean; timeout?: number },
  requestedTab: number,
): Promise<string> {
  const frame = parseFrameObject(raw);
  if (!frame?.ok || !frame.value || typeof frame.value !== "object") return raw;

  const value = frame.value as Record<string, unknown>;
  const tabId = typeof value.tabId === "number" ? value.tabId : requestedTab;
  const resolved = await resolveCdpPort(session.projectPath, session.browser, { timeoutMs: session.timeout });
  const foreground = resolved
    ? await bringTabIdForward(resolved.port, tabId, session)
    : foregroundUnsupported("the session has no debug port to reach the extension background that switches tabs");
  const sentence = foregroundSentence(foreground, session.headless);

  if (foreground.activated && value.tab && typeof value.tab === "object") {
    const stale = tabViewSentence({ tab: tabViewFields(value.tab).tab });
    if (stale && typeof frame.hint === "string") frame.hint = frame.hint.replace(` ${stale}`, "");

    patchValue(frame, { tab: { ...(value.tab as Record<string, unknown>), active: true } });
  }

  patchValue(frame, { foreground });
  frame.hint = `${sentence} ${typeof frame.hint === "string" ? frame.hint : ""}`.trim();
  if (!foreground.activated) addWarning(frame, sentence);

  return actFrameJson(frame);
}
