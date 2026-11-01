// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { actFrameJson, addWarning } from "./act";
import { envelope } from "./envelope";
import { parseFrameObject } from "./frame-json";
import { manifestCandidates } from "./project-manifest";
import { replayToolbarClick, type ToolbarButton } from "./gecko-toolbar-click";

export function declaresSidebarAction(projectPath: string, browser: string): boolean {
  for (const file of manifestCandidates(projectPath, browser)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

      return Boolean(manifest.sidebar_action && typeof manifest.sidebar_action === "object");
    } catch {
      continue;
    }
  }

  return false;
}

export const GESTURE_GATED_APIS =
  "Firefox runs sidebarAction.open, sidebarAction.toggle, permissions.request and action.openPopup only inside a user-input handler; outside one their promise rejects (\"may only be called from a user input handler\"), which a listener that does not await never sees, so the call does nothing";

export async function clickToolbarWithUserInput(
  tool: string,
  projectPath: string,
  browser: string,
  button: ToolbarButton,
  timeout?: number,
): Promise<{ answer: string } | { failed: string }> {
  const why = await replayToolbarClick(projectPath, browser, button, timeout);
  if (why !== null) return { failed: why };

  return {
    answer: envelope({
      ok: true,
      command: tool,
      status: "triggered",
      value: { triggered: "onClicked", manifestKey: button.key, via: "browser-toolbar-action", gesture: "user-input" },
      warnings: [
        `This extension declares a sidebar_action, and ${GESTURE_GATED_APIS}. The engine's own onClicked replay carries no user input, so the server clicked the toolbar button through the browser's own toolbar action in Firefox's parent process over the debugger protocol instead, which Firefox delivers to onClicked as user input, the way a person's click is. Whether the listener ran, and what it did, is not read here.`,
      ],
      hint: "Check what the click did with extension_screenshot or extension_eval context: 'sidebar' (the panel), or extension_logs for the listener's own output.",
    }),
  };
}

export function noteReplayWithoutGesture(raw: string, sidebarDeclared: boolean, clickFailure: string | null): string {
  const frame = parseFrameObject(raw);
  if (!frame || frame.ok !== true || frame.value?.triggered !== "onClicked" || frame.value?.gesture === true) return raw;

  const failed = clickFailure ? ` The server's click through the browser's toolbar action, which does carry user input, did not run: ${clickFailure}.` : "";
  const route = sidebarDeclared
    ? ' To open the panel, extension_open surface: "sidebar" opens the real one through the browser\'s sidebar controller; to exercise the listener\'s own sidebarAction call, a person clicks the toolbar button in a headed session (extension_dev with headless: false).'
    : " To exercise such a call, a person clicks the toolbar button in a headed session (extension_dev with headless: false).";

  addWarning(frame, `The engine replayed action.onClicked without user input (gesture: false), and ${GESTURE_GATED_APIS}.${failed}${route}`);

  return actFrameJson(frame);
}
