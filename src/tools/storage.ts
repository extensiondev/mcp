// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runActVerb, commonFlags, type ActArgs } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_storage",
  description:
    "Read or write chrome.storage in a running extension. Requires the dev session to be started with allowControl: true (extension_dev). Wraps `extension storage get|set`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root (must have an active dev session)",
      },
      action: {
        type: "string",
        enum: ["get", "set"],
        description: "get reads a key (or the whole area); set writes a key",
      },
      area: {
        type: "string",
        enum: ["local", "sync", "session", "managed"],
        default: "local",
      },
      key: { type: "string", description: "Key to get or set" },
      value: {
        description: "Value to set (any JSON value); required for action=set",
      },
      context: {
        type: "string",
        enum: ["background", "popup", "options", "sidebar", "content"],
        default: "background",
      },
      browser: {
        type: "string",
        description:
          "Browser session to target. Defaults to the active dev session's browser for this project.",
      },
      timeout: { type: "number", description: "Command timeout in ms (default 5000)" },
    },
    required: ["projectPath", "action"],
  },
};

export async function handler(
  args: ActArgs & {
    action: "get" | "set";
    area?: string;
    key?: string;
    value?: unknown;
  },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const cli = ["storage", args.action, args.projectPath];
  if (args.area) cli.push("--area", args.area);
  if (args.key) cli.push("--key", args.key);
  if (args.action === "set") {
    if (args.value === undefined) {
      return JSON.stringify({
        ok: false,
        error: { name: "BadRequest", message: "storage set requires a value" },
      });
    }
    // Without this guard the engine answers in CLI vocabulary ("storage set
    // requires --key and --value"), flags the MCP caller never typed. Two
    // API-surface-swarm personas passed a chrome.storage-shaped object and got
    // stranded on it. Name the MCP args and the one-key-per-call shape here.
    if (args.key === undefined) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "BadRequest",
          message:
            'storage set requires `key` (string) and `value` args, one key per call. There is no bulk-object set: to seed {a: 1, b: 2}, call once with key: "a" and once with key: "b".',
        },
      });
    }
    cli.push("--value", JSON.stringify(args.value));
  }
  if (args.context) cli.push("--context", args.context);
  cli.push("--browser", browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));
  return runActVerb(cli, args.projectPath, args.timeout);
}
