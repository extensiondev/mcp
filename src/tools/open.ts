import { runActVerb, type ActArgs } from "../lib/act";

export const schema = {
  name: "extension_open",
  description:
    "Open an extension surface or replay an event in a running session. 'popup'/'options'/'sidebar' open UI surfaces. 'action' triggers the toolbar action: opens the action's popup, or (no popup) replays chrome.action.onClicked. 'command' replays a chrome.commands.onCommand keyboard shortcut (pass `name`). NOTE: action/command replay invokes your listener WITHOUT a user gesture, so the gesture-derived activeTab grant does not apply (the result includes gesture:false and a warning when activeTab is declared). Requires --allow-control. Wraps `extension open`.",
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
      browser: { type: "string", default: "chromium" },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath", "surface"],
  },
};

export async function handler(
  args: ActArgs & { surface: string; name?: string },
): Promise<string> {
  const cli = ["open", args.surface, args.projectPath];
  if (args.surface === "command" && args.name) cli.push("--name", args.name);
  if (args.browser) cli.push("--browser", args.browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  return runActVerb(cli, args.projectPath, args.timeout);
}
