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
        enum: ["chrome", "edge", "firefox", "chromium-based", "gecko-based"],
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
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  zip?: boolean;
  zipSource?: boolean;
}): Promise<string> {
  const start = Date.now();

  try {
    const summary = await extensionBuild(args.projectPath, {
      browser: args.browser ?? "chrome",
      zip: args.zip ?? false,
      zipSource: args.zipSource ?? false,
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
