// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { LAUNCH_BROWSER, PROJECT_PATH } from "../lib/common-schema";
import { pollBootVerdict,
  bootFailureHint,
} from "../lib/boot-verdict";
import { profileCarriesTabsOver } from "../lib/profile-carryover";
import { removeCarrier } from "../lib/carrier";
import { envelope } from "../lib/envelope";
import { productionLaunchEvidence, readFreshContract } from "../lib/production-launch";
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
    "Run the PRODUCTION build in a browser: build the project, serve it, and launch. There is no hot module replacement and no control channel, so your edits are not picked up and extension_eval, extension_storage, extension_reload, extension_open and extension_dom_snapshot cannot attach to this session. Use extension_dev while writing code, and this to check what actually ships. Pass build:false to launch an existing dist/<browser> without rebuilding, or outputPath to launch any prebuilt unpacked extension directory, one another toolchain produced included, which implies build:false. The answer says what it confirmed (the engine process, and the browser pid the launcher recorded once the contract lands) and what a production session cannot confirm (that the browser loaded the extension: it opens no debug port and has no console stream), and names extension_dev for a proven load.",
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
        description: "Passed to the engine as --port (0 for auto-assign). A production start serves nothing over it today; it matters only to a toolchain that reads it.",
      },
      noBrowser: {
        type: "boolean",
        default: false,
        description: "Build (or, with build:false, check the dist) without launching a browser. A production start serves nothing, so with no browser the engine process ends once the build does; read the result with extension_build rather than a session.",
      },
      outputPath: {
        type: "string",
        description:
          "An existing unpacked extension directory to launch as it is (a manifest.json at its root), for an artifact built by another toolchain or an exact release candidate. Implies build:false; projectPath still names the project the session belongs to. Relative paths resolve against projectPath.",
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
    outputPath?: string;
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";
  const outputPath =
    typeof args.outputPath === "string" && args.outputPath.trim()
      ? path.resolve(args.projectPath, args.outputPath.trim())
      : null;

  if (outputPath) {
    const manifest = path.join(outputPath, "manifest.json");

    if (!fs.existsSync(manifest)) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "no-unpacked-extension",
        error: {
          code: "E_NO_DIST",
          name: "NoUnpackedExtension",
          message: `outputPath ${outputPath} holds no manifest.json, so there is no unpacked extension to launch.`,
        },
        hint: "Point outputPath at the directory that holds the built manifest.json (for an Extension.js project that is dist/<browser>; for another toolchain, its build output), or omit it to build and run the project.",
      });
    }
  }

  const building = args.build !== false && !outputPath;
  const command = building ? "start" : "preview";

  if (browser === "safari" || browser === "webkit-based") {
    return envelope({
      ok: false,
      command: schema.name,
      status: "unsupported-browser",
      error: {
        code: "E_UNSUPPORTED_BROWSER",
        message: `The engine's ${command} verb does not run Safari; extension_dev builds, packages and opens the Safari app.`,
      },
      hint: "Use extension_dev with browser: \"safari\", or extension_build with browser: \"safari\" for the packaged app.",
    });
  }

  if (!building && (args.host || args.publicHost)) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        message: `host and publicHost are not options of the engine's preview verb, which build: false and outputPath run; they apply only when start builds.`,
      },
      hint: "Drop host and publicHost, or let extension_start build (build: true, no outputPath).",
    });
  }

  const cliArgs = [command, args.projectPath, "--browser", browser];
  if (outputPath) cliArgs.push("--output-path", outputPath);
  if (building && args.polyfill === false) cliArgs.push("--polyfill", "false");
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");

  cliArgs.push(...launchFlagArgs(args));

  const stale = removeCarrier(args.projectPath);

  const profileReused = profileCarriesTabsOver(
    args.projectPath,
    browser,
    args.profile,
  );
  const spawnedAt = Date.now();
  const spawned = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const { child } = spawned;

  if (child.pid === undefined) {
    return spawnFailedEnvelope(schema.name, spawned);
  }

  const pid = child.pid;

  const markerWarning = registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command,
    profileReused,
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
  const session = { projectPath: args.projectPath, browser, pid };

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
        ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}),
      },
      hint: building
        ? "Read `value.output` above for the cause: a failed production build, a port already in use, or a missing browser binary are the common ones. extension_build will surface a build error on its own."
        : "Read `value.output` above for the cause: a missing or broken dist/ (run extension_build first, or drop build:false), or a missing browser binary are the common ones.",
      warnings: boot.warnings,
    });
  }

  if (boot.verdict.kind === "boot-failed") {
    const { code, message } = boot.verdict;

    return envelope({
      ok: false,
      command: schema.name,
      status: "boot-failed",
      error: {
        code: "E_CONTRACT_ERROR",
        message: `The session recorded status: error${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}. The process is running; the extension is not.`,
      },
      value: {
        ...session,
        ...(code ? { engineCode: code } : {}),
        output: cleanOutput.slice(0, 2000),
        ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}),
      },
      hint: bootFailureHint(code),
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
        ...(compileErrors.length ? {} : { output: cleanOutput.slice(0, 2000), ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}) }),
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

  const launch = productionLaunchEvidence(
    readFreshContract(args.projectPath, browser, spawnedAt),
  );
  const launchSeen =
    launch.browserPid === null
      ? "the contract has not recorded a browser launch yet; extension_wait reads it once the build lands (browserPid, browserAlive)"
      : `the contract names the browser it launched (pid ${launch.browserPid}, ${launch.browserAlive ? "alive" : "gone"})`;

  return envelope({
    ok: true,
    command: schema.name,
    status: "started",
    value: {
      pid,
      browser,
      projectPath: args.projectPath,
      verb: command,
      observed: "the engine process was alive 5 s after it was spawned",
      ...launch,
    },
    hint: `The engine's ${command} process was alive 5 s after spawn and ${launchSeen}. What a production session cannot confirm is that ${browser} loaded the extension: it opens no debug port and carries no dev bridge, so extension_logs has no console stream to read for it and the control verbs cannot attach. To prove the load, run it with extension_dev, whose answer carries guestLoaded. When you are done, call extension_stop to shut the session down.`,
    warnings: [
      ...boot.warnings,
      markerWarning,
      stale.removed &&
        "Removed a Live Preview carrier left behind by an earlier dev session, so it was not loaded beside your extension here.",
      !stale.removed &&
        stale.note &&
        /Could not remove/i.test(stale.note) &&
        `${stale.note} A Live Preview carrier is still in ./extensions and the engine loads that folder, so this run has the debug companion beside your extension.`,
    ],
  });
}
