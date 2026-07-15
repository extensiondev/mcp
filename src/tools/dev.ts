import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";

export const schema = {
  name: "extension_dev",
  description:
    "Start the extension development server with hot module replacement. Launches a browser with the extension loaded. Returns process info for use with extension_wait and extension_source_inspect.",
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
      port: {
        type: "number",
        description: "Dev server port (0 for auto-assign)",
      },
      noBrowser: {
        type: "boolean",
        default: false,
        description: "Start dev server without launching browser",
      },
      allowControl: {
        type: "boolean",
        default: false,
        description:
          "Enable the agent-bridge control channel so extension_storage/reload/open/dom_inspect work against this session",
      },
      allowEval: {
        type: "boolean",
        default: false,
        description:
          "Additionally enable extension_eval (runs code in a context; writes a 0600 session token)",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  port?: number;
  noBrowser?: boolean;
  allowControl?: boolean;
  allowEval?: boolean;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const cliArgs = ["dev", args.projectPath, "--browser", browser];
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");
  if (args.allowControl) cliArgs.push("--allow-control");
  if (args.allowEval) cliArgs.push("--allow-eval");

  const child = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    port: args.port,
    projectPath: args.projectPath,
    command: "dev",
  });
  // Keep the registry honest: a session that dies on its own (crash, user
  // closes the browser, Ctrl+C on the terminal) should not linger as stoppable.
  child.on("exit", () => removeSession(args.projectPath, browser));

  // Collect initial output for a few seconds so we can report early errors
  let earlyOutput = "";
  const collector = (data: Buffer) => {
    earlyOutput += data.toString();
  };
  child.stdout?.on("data", collector);
  child.stderr?.on("data", collector);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  child.stdout?.off("data", collector);
  child.stderr?.off("data", collector);

  return JSON.stringify({
    pid,
    browser,
    port: args.port ?? 8080,
    projectPath: args.projectPath,
    status: "started",
    hint: "Use extension_wait to check when the extension is fully loaded, then extension_source_inspect to inspect the live state. When you are done, call extension_stop to shut down the dev server and browser.",
    earlyOutput: earlyOutput.slice(0, 500),
  });
}
