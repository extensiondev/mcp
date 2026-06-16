import { spawnExtensionCli } from "../lib/exec";

export const schema = {
  name: "extension_preview",
  description:
    "Preview a production-built extension in a browser. Uses dist/ output directly. The extension must be built first with extension_build.",
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
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const cliArgs = ["preview", args.projectPath, "--browser", browser];

  const child = spawnExtensionCli(cliArgs);

  return JSON.stringify({
    pid: child.pid,
    browser,
    projectPath: args.projectPath,
    status: "launched",
  });
}
