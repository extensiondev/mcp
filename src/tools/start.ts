import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";

export const schema = {
  name: "extension_start",
  description:
    "Build the extension for production and immediately preview it in a browser. Combines build + preview in one step. No hot reload.",
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
      polyfill: {
        type: "boolean",
        default: true,
        description: "Apply cross-browser polyfill",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  polyfill?: boolean;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const cliArgs = ["start", args.projectPath, "--browser", browser];
  if (args.polyfill === false) cliArgs.push("--no-polyfill");

  const child = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command: "start",
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  let earlyOutput = "";
  const collector = (data: Buffer) => {
    earlyOutput += data.toString();
  };
  child.stdout?.on("data", collector);
  child.stderr?.on("data", collector);

  await new Promise((resolve) => setTimeout(resolve, 5000));
  child.stdout?.off("data", collector);
  child.stderr?.off("data", collector);

  return JSON.stringify({
    pid,
    browser,
    projectPath: args.projectPath,
    status: "started",
    hint: "Use extension_wait to check when the build and browser launch are complete. When you are done, call extension_stop to shut down the session.",
    earlyOutput: earlyOutput.slice(0, 500),
  });
}
