// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { extensionUninstall } from "extension-install";

export const schema = {
  name: "extension_uninstall_browser",
  description:
    "Remove a managed browser binary from the Extension.js cache. Only touches the managed cache, never system-installed browsers.",
  inputSchema: {
    type: "object" as const,
    properties: {
      browser: {
        type: "string",
        enum: ["chrome", "chromium", "edge", "firefox"],
        description: "Managed browser to remove",
      },
      all: {
        type: "boolean",
        default: false,
        description: "Remove every managed browser binary",
      },
    },
    required: [],
  },
};

export async function handler(args: {
  browser?: string;
  all?: boolean;
}): Promise<string> {
  const start = Date.now();

  if (!args.browser && !args.all) {
    return JSON.stringify({
      status: "error",
      message: "Provide a browser to remove, or set all: true.",
    });
  }

  try {
    await extensionUninstall({ browser: args.browser, all: args.all });

    return JSON.stringify({
      status: "uninstalled",
      target: args.all ? "all" : args.browser,
      duration: Date.now() - start,
      hint: "Use extension_list_browsers to confirm what remains in the managed cache.",
    });
  } catch (err) {
    return JSON.stringify({
      status: "error",
      target: args.all ? "all" : args.browser,
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    });
  }
}
