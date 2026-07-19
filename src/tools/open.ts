// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_open",
  description:
    "Open an extension surface or replay an event in a running session. 'popup'/'options'/'sidebar' open UI surfaces. 'action' triggers the toolbar action: opens the action's popup, or (no popup) replays chrome.action.onClicked. 'command' replays a chrome.commands.onCommand keyboard shortcut (pass `name`). NOTE: action/command replay invokes your listener WITHOUT a user gesture, so the gesture-derived activeTab grant does not apply (the result includes gesture:false and a warning when activeTab is declared). Requires the dev session to be started with allowControl: true (extension_dev). Wraps `extension open`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      surface: {
        type: "string",
        enum: ["popup", "options", "sidebar", "action", "command"],
        description: "Which surface to open or event to replay. 'action' triggers the toolbar action; 'command' replays a keyboard-shortcut command (requires `name`).",
      },
      name: {
        type: "string",
        description: "For surface 'command': the chrome.commands name to trigger.",
      },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath", "surface"],
  },
};

export async function handler(
  args: ActArgs & { surface: string; name?: string },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const cli = ["open", args.surface, args.projectPath];
  if (args.surface === "command" && args.name) cli.push("--name", args.name);
  cli.push("--browser", browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  const raw = await runActVerb(cli, args.projectPath, args.timeout);

  // Opening a UI surface needs a headed window; under EXTENSION_HEADLESS the
  // engine reports "no active browser window" with no hint as to why. Name the
  // real cause so the caller knows to relaunch headed rather than debug a
  // phantom failure.
  const headless = /^(1|true)$/i.test(process.env.EXTENSION_HEADLESS ?? "");
  if (headless && ["popup", "action", "sidebar"].includes(args.surface)) {
    try {
      const parsed = JSON.parse(raw);
      const msg = String(parsed?.error?.message ?? "");
      if (parsed?.ok === false && !parsed.hint && /active browser window|no active|headless/i.test(msg)) {
        parsed.hint =
          "The dev browser is running headless (EXTENSION_HEADLESS), which has no visible window to attach a popup/sidebar to. Relaunch a headed dev session to open UI surfaces.";
        return JSON.stringify(parsed);
      }
    } catch {
      // non-JSON payload; return as-is
    }
  }
  return raw;
}
