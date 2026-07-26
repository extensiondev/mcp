// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LAUNCH_BROWSER, PROJECT_PATH } from "../lib/common-schema";
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
    "Run the PRODUCTION build in a browser: builds the project, then serves it and launches. No hot module replacement and no control channel, so your edits are not picked up and extension_eval/storage/reload/open/dom_snapshot cannot attach to this session. Use extension_dev while writing code; use this to check what actually ships. Pass build:false to launch on an existing dist/<browser> without rebuilding.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: LAUNCH_BROWSER,
      build: {
        type: "boolean",
        default: true,
        description:
          "Build before serving. false serves the existing dist/<browser> as-is and fails when there is none.",
      },
      polyfill: {
        type: "boolean",
        default: true,
        description: "Apply cross-browser polyfill (build only)",
      },
      port: {
        type: "number",
        description: "Server port (0 for auto-assign)",
      },
      noBrowser: {
        type: "boolean",
        default: false,
        description: "Serve without launching a browser",
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
    build?: boolean;
    polyfill?: boolean;
    port?: number;
    noBrowser?: boolean;
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";
  const building = args.build !== false;
  const command = building ? "start" : "preview";
  const cliArgs = [command, args.projectPath, "--browser", browser];
  if (building && args.polyfill === false) cliArgs.push("--polyfill", "false");
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
    command,
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const earlyOutput = spawned.readOutput();

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
        `The ${command} process exited during startup (${signal ? `signal ${signal}` : `exit code ${code}`}). ` +
        "No session is running.",
      output: earlyOutput.slice(0, 2000),
      logPath,
      hint: building
        ? "Read `output` above for the cause: a failed production build, a port already in use, or a missing browser binary are the common ones. extension_build will surface a build error on its own."
        : "Read `output` above for the cause: a missing or broken dist/ (run extension_build first, or drop build:false), or a missing browser binary are the common ones.",
    });
  }

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
        `The ${command} process is running but the browser it launched has exited ` +
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
    status: building ? "started" : "launched",
    hint: building
      ? "Use extension_wait to check when the build and browser launch are complete. When you are done, call extension_stop to shut down the session."
      : "Call extension_stop when you are done to close the preview browser.",
    earlyOutput: earlyOutput.slice(0, 500),
    logPath,
  });
}
