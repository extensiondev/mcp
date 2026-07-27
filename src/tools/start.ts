// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LAUNCH_BROWSER, PROJECT_PATH } from "../lib/common-schema";
import { pollBootVerdict } from "../lib/boot-verdict";
import { envelope } from "../lib/envelope";
import { spawnExtensionCli, spawnFailedEnvelope } from "../lib/exec";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import {
  LAUNCH_FLAG_SCHEMA,
  launchFlagArgs,
  type LaunchFlagArgs,
} from "../lib/launch-flags";

export const schema = {
  name: "extension_start",
  description:
    "Run the PRODUCTION build in a browser: build the project, serve it, and launch. There is no hot module replacement and no control channel, so your edits are not picked up and extension_eval, extension_storage, extension_reload, extension_open and extension_dom_snapshot cannot attach to this session. Use extension_dev while writing code, and this to check what actually ships. Pass build:false to launch an existing dist/<browser> without rebuilding.",
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
  if (child.pid === undefined) {
    return spawnFailedEnvelope(schema.name, spawned);
  }
  const pid = child.pid;

  registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command,
  });
  child.on("exit", () => {
    removeSession(args.projectPath, browser, pid);
    removeSessionMarker(args.projectPath, browser, pid);
  });

  const boot = await pollBootVerdict(args.projectPath, browser, {
    child,
    readOutput: spawned.readOutput,
    budgetMs: 5000,
    since: spawnedAt,
    noBrowser: Boolean(args.noBrowser),
  });
  const cleanOutput = boot.evidenceTail;
  const session = { projectPath: args.projectPath, browser, pid, logPath };

  if (boot.verdict.kind === "exited") {
    const { exitCode: code, signal } = boot.verdict;
    return envelope({
      ok: false,
      command: schema.name,
      status: "exited",
      error: {
        code: "E_SESSION_EXITED",
        message:
          `The ${command} process exited during startup (${signal ? `signal ${signal}` : `exit code ${code}`}). ` +
          "No session is running.",
      },
      value: {
        ...session,
        exitCode: code,
        signal,
        output: cleanOutput.slice(0, 2000),
      },
      hint: building
        ? "Read `value.output` above for the cause: a failed production build, a port already in use, or a missing browser binary are the common ones. extension_build will surface a build error on its own."
        : "Read `value.output` above for the cause: a missing or broken dist/ (run extension_build first, or drop build:false), or a missing browser binary are the common ones.",
      warnings: boot.warnings,
    });
  }

  if (boot.verdict.kind === "compile-failed") {
    const { compileErrors } = boot.verdict;
    return envelope({
      ok: false,
      command: schema.name,
      status: "compile-failed",
      error: {
        code: "E_FIRST_COMPILE",
        message:
          boot.verdict.message ??
          `The ${command} process is running but the build failed, so the browser has nothing usable to load.`,
      },
      value: {
        ...session,
        buildErrors: compileErrors,
        ...(compileErrors.length ? {} : { output: cleanOutput.slice(0, 2000) }),
      },
      hint: "Fix the build error listed in `value.buildErrors`, then call extension_start again. extension_build reports the same failure on its own.",
      warnings: boot.warnings,
    });
  }

  if (
    boot.verdict.kind === "browser-exited" ||
    boot.verdict.kind === "profile-locked"
  ) {
    const stamp =
      boot.verdict.kind === "browser-exited" ? boot.verdict.stamp : {};
    return envelope({
      ok: false,
      command: schema.name,
      status: boot.verdict.kind,
      error: {
        code:
          boot.verdict.kind === "profile-locked"
            ? "E_PROFILE_LOCKED"
            : "E_BROWSER_EXITED",
        message:
          `The ${command} process is running but the browser it launched has exited ` +
          "(the extension may have been rejected or the browser crashed). The session cannot be driven.",
      },
      value: { ...session, ...stamp, output: cleanOutput.slice(0, 2000) },
      hint: "Read `value.output` above and extension_logs for the cause, then call extension_stop to clean up before retrying.",
      warnings: boot.warnings,
    });
  }

  return envelope({
    ok: true,
    command: schema.name,
    status: building ? "started" : "launched",
    value: {
      pid,
      browser,
      projectPath: args.projectPath,
      logPath,
    },
    hint: building
      ? "Use extension_wait to check when the build and browser launch are complete. When you are done, call extension_stop to shut down the session."
      : "Call extension_stop when you are done to close the preview browser.",
    warnings: boot.warnings,
  });
}
