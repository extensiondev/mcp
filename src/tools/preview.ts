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

  const spawnedAt = Date.now();
  const spawned = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const { child, logPath } = spawned;
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command: "preview",
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const earlyOutput = spawned.readOutput();

  // Same health tick as extension_dev/start: this used to return
  // status:"launched" unconditionally, so a preview process that died within
  // seconds (nothing ever serving) still read as a live session.
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
        `The preview process exited during startup (${signal ? `signal ${signal}` : `exit code ${code}`}). ` +
        "Nothing is running.",
      output: earlyOutput.slice(0, 2000),
      logPath,
      hint: "Read `output` above for the cause: a missing or broken dist/ (run extension_build first), or a missing browser binary are the common ones.",
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
    status: "launched",
    hint: "Call extension_stop when you are done to close the preview browser.",
    earlyOutput: earlyOutput.slice(0, 500),
    logPath,
  });
}
