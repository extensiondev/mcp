// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { extensionBuild } from "extension-develop";

export const schema = {
  name: "extension_build",
  description:
    "Build a browser extension for production. Outputs to dist/<browser>/. Optionally creates .zip for store submission.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        enum: ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        default: "chrome",
        description: "Target browser",
      },
      zip: {
        type: "boolean",
        default: false,
        description: "Create a .zip file for store distribution",
      },
      zipSource: {
        type: "boolean",
        default: false,
        description: "Include source code zip (required by some stores)",
      },
      zipFilename: {
        type: "string",
        description: "Custom .zip file name (defaults to name and version)",
      },
      polyfill: {
        type: "boolean",
        default: false,
        description: "Apply cross-browser polyfill",
      },
      silent: {
        type: "boolean",
        default: false,
        description: "Suppress build output",
      },
      mode: {
        type: "string",
        enum: ["development", "production", "none"],
        default: "production",
        description: "Bundler mode override (also sets NODE_ENV)",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  zip?: boolean;
  zipSource?: boolean;
  zipFilename?: string;
  polyfill?: boolean;
  silent?: boolean;
  mode?: "development" | "production" | "none";
}): Promise<string> {
  const start = Date.now();

  try {
    const summary = await extensionBuild(args.projectPath, {
      browser: args.browser ?? "chrome",
      zip: args.zip ?? false,
      zipSource: args.zipSource ?? false,
      ...(args.zipFilename ? { zipFilename: args.zipFilename } : {}),
      ...(args.polyfill !== undefined ? { polyfill: args.polyfill } : {}),
      ...(args.silent !== undefined ? { silent: args.silent } : {}),
      ...(args.mode ? { mode: args.mode } : {}),
      exitOnError: false,
    });

    return JSON.stringify({
      success: true,
      ...summary,
      duration: Date.now() - start,
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
      hint: "Check that the project has a valid src/manifest.json and all dependencies are installed.",
    });
  }
}
