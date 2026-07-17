// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";
import {
  LAUNCH_FLAG_SCHEMA,
  launchFlagArgs,
  type LaunchFlagArgs,
} from "../lib/launch-flags";

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
        enum: ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        default: "chrome",
      },
      port: {
        type: "number",
        description: "Server port (0 for auto-assign)",
      },
      noBrowser: {
        type: "boolean",
        default: false,
        description: "Serve the preview without launching a browser",
      },
      ...LAUNCH_FLAG_SCHEMA,
    },
    required: ["projectPath"],
  },
};

export async function handler(
  args: {
    projectPath: string;
    browser?: string;
    port?: number;
    noBrowser?: boolean;
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";
  const cliArgs = ["preview", args.projectPath, "--browser", browser];
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");
  cliArgs.push(...launchFlagArgs(args));

  const child = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command: "preview",
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  return JSON.stringify({
    pid,
    browser,
    projectPath: args.projectPath,
    status: "launched",
    hint: "Call extension_stop when you are done to close the preview browser.",
  });
}
