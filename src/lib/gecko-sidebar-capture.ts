// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { captureRdpTab, type CaptureOutcome, type CaptureSize } from "./capture";
import { geckoSidebarPanel } from "./gecko-sidebar";

export type SidebarCapture = { outcome: CaptureOutcome; url: string; note: string } | { closed: string };

export async function captureGeckoSidebarPanel(
  projectPath: string,
  browser: string,
  port: number,
  size: CaptureSize,
  timeoutMs: number,
): Promise<SidebarCapture> {
  const read = await geckoSidebarPanel(projectPath, browser, { open: false, timeout: timeoutMs });
  if ("reason" in read) return { closed: `the open sidebar could not be read over the debugger protocol: ${read.reason}` };

  const { panel } = read;
  if (!panel.open) return { closed: "the sidebar panel is not open in the front window" };
  if (panel.browsingContextId == null) return { closed: "the open sidebar panel announced no browsing context to capture" };

  const outcome = await captureRdpTab(port, panel.browsingContextId, size, timeoutMs);
  const measured = panel.width != null && panel.height != null ? ` at the panel's own ${panel.width}x${panel.height} CSS px` : "";

  return {
    outcome,
    url: panel.url ?? "the sidebar panel",
    note: `Captured the real sidebar panel${measured}, read through Firefox's parent process over the debugger protocol, not a tab rendering of its document.`,
  };
}
