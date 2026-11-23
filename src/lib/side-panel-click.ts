// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { evaluateOnExtensionPage } from "./cdp-extension-page";
import { resolveCdpPort } from "./cdp-port";
import { manifestCandidates } from "./project-manifest";
import { tabsWorker } from "./tab-switch-worker";

export const PANEL_BEHAVIOR_TIMEOUT_MS = 5_000;

export const IDLE_ACTION_REFUSAL = /has no popup and no \S+\.onClicked listener/;

export type PanelBehaviorRead = { read: true; opensOnClick: boolean } | { read: false; reason: string };

export const PANEL_BEHAVIOR_SCRIPT = `(async () => {
  var api = typeof chrome !== "undefined" && chrome.sidePanel;
  if (!api || typeof api.getPanelBehavior !== "function") return { outcome: "no-api" };
  var behavior = await api.getPanelBehavior();
  return { outcome: "read", openPanelOnActionClick: !!(behavior && behavior.openPanelOnActionClick) };
})()`;

export function declaresSidePanel(projectPath: string, browser: string): boolean {
  for (const file of manifestCandidates(projectPath, browser)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;

      return typeof manifest.side_panel?.default_path === "string" && manifest.side_panel.default_path.length > 0;
    } catch {
      continue;
    }
  }

  return false;
}

export async function readPanelBehavior(projectPath: string, browser: string, timeoutMs?: number): Promise<PanelBehaviorRead> {
  const resolved = await resolveCdpPort(projectPath, browser, { timeoutMs });
  if (!resolved) return { read: false, reason: "the session exposes no debug port (CDP)" };

  const worker = await tabsWorker(resolved.port, projectPath, browser);
  if ("reason" in worker) return { read: false, reason: worker.reason.replace(/ to switch tabs from$/, "") };

  const ran = await evaluateOnExtensionPage(resolved.port, worker.targetId, PANEL_BEHAVIOR_SCRIPT, timeoutMs ?? PANEL_BEHAVIOR_TIMEOUT_MS);
  if (!ran.ok) return { read: false, reason: ran.message };

  const answer = (ran.value && typeof ran.value === "object" ? ran.value : {}) as { outcome?: unknown; openPanelOnActionClick?: unknown };

  if (answer.outcome === "read") return { read: true, opensOnClick: answer.openPanelOnActionClick === true };
  if (answer.outcome === "no-api") return { read: false, reason: "chrome.sidePanel.getPanelBehavior is not available in the service worker" };

  return { read: false, reason: "the service worker answered no panel behavior" };
}
