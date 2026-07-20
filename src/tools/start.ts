// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";
import { browserExitStamp } from "../lib/session-browser";
import {
  LAUNCH_FLAG_SCHEMA,
  launchFlagArgs,
  type LaunchFlagArgs,
} from "../lib/launch-flags";

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
        enum: ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
        default: "chrome",
      },
      polyfill: {
        type: "boolean",
        default: true,
        description: "Apply cross-browser polyfill",
      },
      port: {
        type: "number",
        description: "Server port (0 for auto-assign)",
      },
      noBrowser: {
        type: "boolean",
        default: false,
        description: "Build and serve without launching a browser",
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
    polyfill?: boolean;
    port?: number;
    noBrowser?: boolean;
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";
  const cliArgs = ["start", args.projectPath, "--browser", browser];
  if (args.polyfill === false) cliArgs.push("--polyfill", "false");
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");
  cliArgs.push(...launchFlagArgs(args));

  const spawnedAt = Date.now();
  const spawned = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const { child, logPath } = spawned;
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command: "start",
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const earlyOutput = spawned.readOutput();

  // Same health tick as extension_dev: reporting status:"started" for a process
  // that already exited sends the caller to extension_wait against a session
  // that will never be ready.
  if (child.exitCode !== null || child.signalCode !== null) {
    const code = child.exitCode;
    const signal = child.signalCode;
    return JSON.stringify({
      ok: false,
      status: "exited",
      projectPath: args.projectPath,
      browser,
      pid,
      exitCode: code,
      signal,
      error:
        `The preview server exited during startup (${signal ? `signal ${signal}` : `exit code ${code}`}). ` +
        "No session is running.",
      output: earlyOutput.slice(0, 2000),
      logPath,
      hint: "Read `output` above for the cause: a failed production build, a port already in use, or a missing browser binary are the common ones. extension_build will surface a build error on its own.",
    });
  }

  // The CLI can outlive the browser it launched. Engines with the bug-71/72
  // fixes stamp ready.json status:"error" code:"browser_exited" when that
  // happens; a dead browser IS a dead run-only session, so report it.
  const exitStamp = browserExitStamp(args.projectPath, browser, spawnedAt);
  if (exitStamp) {
    return JSON.stringify({
      ok: false,
      status: "browser-exited",
      projectPath: args.projectPath,
      browser,
      pid,
      ...exitStamp,
      error:
        "The preview process is running but the browser it launched has exited " +
        "(the extension may have been rejected or the browser crashed). The session cannot be driven.",
      output: earlyOutput.slice(0, 2000),
      logPath,
      hint: "Read `output` above and extension_logs for the cause, then call extension_stop to clean up before retrying.",
    });
  }

  return JSON.stringify({
    ok: true,
    pid,
    browser,
    projectPath: args.projectPath,
    status: "started",
    hint: "Use extension_wait to check when the build and browser launch are complete. When you are done, call extension_stop to shut down the session.",
    earlyOutput: earlyOutput.slice(0, 500),
    logPath,
  });
}
