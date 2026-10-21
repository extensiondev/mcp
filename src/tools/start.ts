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
  bootFailureMessage,
} from "../lib/boot-verdict";
import { stopFailedBoot } from "../lib/boot-failed-stop";
import {
  profileCarryoverBeforeLaunch,
  profileReusedAt,
  reusedProfileNote,
} from "../lib/profile-carryover";
import { removeCarrier } from "../lib/carrier";
import { envelope } from "../lib/envelope";
import { productionLaunchEvidence, readFreshContract, readLoadOverDebugPort } from "../lib/production-launch";
import { unpackedExtensionId } from "../lib/extension-identity";
import { spawnExtensionCli, spawnFailedEnvelope } from "../lib/exec";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import { guardSameBrowserSession } from "../lib/same-browser-session";
import {
  LAUNCH_FLAG_SCHEMA,
  headlessHint,
  headlessLaunch,
  launchFlagArgs,
  type LaunchFlagArgs,
} from "../lib/launch-flags";

/* @invariant A CONTROLLED RUN NAMES ITS OWN ID. An unpacked extension's id
 * comes from its folder, and allowControl loads a copy of the build from
 * dist/extension-js/<browser>/controlled, so the controlled run and the plain
 * dist/<browser> run are two extensions to the browser. On 2026-10-21 the
 * answer said nothing, a startingUrl built from the plain id opened an empty
 * chrome://extensions page, and the profile note promised storage the copy
 * never had. The answer now carries both ids, rewrites a startingUrl that
 * names the plain id, and says what the copy does not inherit.
 */
type ControlledIdentity = {
  plainId: string;
  copyId: string | null;
  startingUrl?: string;
  rewroteStartingUrl: boolean;
};

function controlledIdentity(args: {
  projectPath: string;
  browser: string;
  outputPath: string | null | undefined;
  allowControl: boolean;
  startingUrl?: string;
}): ControlledIdentity {
  const plainDist = args.outputPath
    ? path.resolve(args.projectPath, args.outputPath)
    : path.join(args.projectPath, "dist", args.browser);
  const plainId = unpackedExtensionId(plainDist);

  if (!args.allowControl) {
    return { plainId, copyId: null, startingUrl: args.startingUrl, rewroteStartingUrl: false };
  }

  const copyId = unpackedExtensionId(path.join(args.projectPath, "dist", "extension-js", args.browser, "controlled"));
  const startingUrl = args.startingUrl;

  if (startingUrl && startingUrl.includes(plainId)) {
    return { plainId, copyId, startingUrl: startingUrl.split(plainId).join(copyId), rewroteStartingUrl: true };
  }

  return { plainId, copyId, startingUrl, rewroteStartingUrl: false };
}

function identityWarnings(identity: ControlledIdentity, launchedId: string | undefined): Array<string | null> {
  if (!identity.copyId) return [];

  const actual = launchedId ?? identity.copyId;
  const predicted = launchedId === undefined || launchedId === identity.copyId;

  return [
    `allowControl runs a copy of the build, and an unpacked extension's id comes from its folder, so this session's extension id is ${actual}, not the ${identity.plainId} that dist/<browser> gets: every chrome-extension:// address and every chrome://extensions/?options= address for this run uses ${actual}, and the copy shares no chrome.storage and no grants with the plain build's runs.`,
    identity.rewroteStartingUrl
      ? predicted
        ? `startingUrl named the plain build's id ${identity.plainId}; it was rewritten to ${identity.copyId} so it opens on this run.`
        : `startingUrl named the plain build's id ${identity.plainId} and was rewritten to ${identity.copyId}, but the contract recorded ${launchedId}; open the page again with that id.`
      : null,
  ];
}

export const schema = {
  name: "extension_start",
  description:
    "Run the PRODUCTION build in a browser: build the project, serve it, and launch. There is no hot module replacement, so your edits are not picked up; use extension_dev while writing code, and this to check what actually ships. By default there is no control channel either, so extension_eval, extension_storage, extension_reload, extension_open and extension_dom_snapshot cannot attach; pass allowControl:true (or allowEval:true, which implies it) to drive the production run with them. Both flags need Extension.js 4.1.34, not yet released; a project on 4.1.33 is refused as engine-unsupported, naming the flag, and extension_dev drives the run instead. Pass build:false to launch an existing dist/<browser> without rebuilding, or outputPath to launch any prebuilt unpacked extension directory. The answer says what it confirmed (the engine process, and the browser pid the launcher recorded once the contract lands) and what a production session cannot confirm (that the browser loaded the extension: it opens no debug port and has no console stream), and names extension_dev for a proven load.",
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
      allowControl: {
        type: "boolean",
        default: false,
        description:
          "Open the agent-bridge control channel on the production run, so extension_storage, extension_reload, extension_open and extension_dom_snapshot reach it. The browser loads a copy of the build with the control producer prepended to the background; dist/<browser> keeps the shipped bytes, and extension_reload then reloads the installed extension under open tabs the way a store update does, which is how to test content scripts an update orphans. Needs an engine that honors the flag (Extension.js 4.1.34); on 4.1.33 the call is refused as engine-unsupported.",
      },
      allowEval: {
        type: "boolean",
        default: false,
        description:
          "Also enable extension_eval on the production run (writes a 0600 session token). Implies allowControl. The build's own content_security_policy still governs eval in its extension pages and background.",
      },
      outputPath: {
        type: "string",
        description:
          "An existing unpacked extension directory to launch as it is (a manifest.json at its root), for an artifact built by another toolchain or an exact release candidate. Implies build:false; projectPath still names the project the session belongs to. Relative paths resolve against projectPath.",
      },
      replace: {
        type: "boolean",
        default: false,
        description:
          "Stop the live session this projectPath runs for the same browser first (an extension_dev or extension_start session), reported as replacedSession. Without it the call is refused: one session per browser owns dist/<browser> and its ready.json and eval token, and a production start would rebuild them under the running session. A session for another browser keeps running either way.",
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
    allowControl?: boolean;
    allowEval?: boolean;
    replace?: boolean;
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

  const guard = await guardSameBrowserSession({
    tool: schema.name,
    projectPath: args.projectPath,
    browser,
    replace: args.replace,
    hazard: `a production ${command} for ${browser} would rebuild or reload them under it; the engine refuses only a second dev session, so this server refuses here.`,
    replacing: "the production run",
  });
  if ("refusal" in guard) return guard.refusal;

  const { replaced } = guard;

  const cliArgs = [command, args.projectPath, "--browser", browser];
  if (outputPath) cliArgs.push("--output-path", outputPath);
  if (building && args.polyfill === false) cliArgs.push("--polyfill", "false");
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");

  const allowEval = Boolean(args.allowEval);
  const allowControl = Boolean(args.allowControl) || allowEval;

  if (allowControl) cliArgs.push("--allow-control");
  if (allowEval) cliArgs.push("--allow-eval");

  const identity = controlledIdentity({
    projectPath: args.projectPath,
    browser,
    outputPath,
    allowControl,
    startingUrl: args.startingUrl,
  });

  cliArgs.push(...launchFlagArgs(identity.startingUrl === args.startingUrl ? args : { ...args, startingUrl: identity.startingUrl }));

  const stale = removeCarrier(args.projectPath);

  const carryover = profileCarryoverBeforeLaunch(
    args.projectPath,
    browser,
    args.profile,
  );
  const spawnedAt = Date.now();
  const visibility = headlessLaunch(args);
  const spawned = spawnExtensionCli(cliArgs, {
    projectDir: args.projectPath,
    ...(visibility.env ? { env: visibility.env } : {}),
  });
  const { child } = spawned;

  if (child.pid === undefined) {
    return spawnFailedEnvelope(schema.name, spawned);
  }

  const pid = child.pid;

  let markerWarning = registerSession({
    pid,
    browser,
    projectPath: args.projectPath,
    command,
    profileReused: carryover.reused,
    headless: visibility.headless,
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
    const refusedFlag = allowControl
      ? /unknown option '(--allow-(?:control|eval))'/.exec(`${cleanOutput}\n${spawned.readOutput()}`)
      : null;

    if (refusedFlag) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "engine-unsupported",
        error: {
          code: "E_ENGINE_TOO_OLD",
          message: `The project's Extension.js engine refused ${refusedFlag[1]}: its ${command} verb has no control channel. The published extension 4.1.33 does not have it; a production run takes --allow-control and --allow-eval from the first engine release after 4.1.33. No session is running.`,
        },
        value: { ...session, exitCode: code, signal, allowControl, allowEval },
        hint: "Upgrade the project's engine (npm i -D extension@latest) once a release with start --allow-control is out, or drive the run with extension_dev, which carries the control channel today. extension_start without allowControl still runs the production build.",
        warnings: boot.warnings,
      });
    }

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
    const stop = await stopFailedBoot(args.projectPath, browser);

    return envelope({
      ok: false,
      command: schema.name,
      status: "boot-failed",
      error: {
        code: "E_CONTRACT_ERROR",
        message: bootFailureMessage(code, message, stop.sessionStopped),
      },
      value: {
        ...session,
        ...(code ? { engineCode: code } : {}),
        ...stop,
        output: cleanOutput.slice(0, 2000),
        ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}),
      },
      hint: bootFailureHint(code, { sessionStopped: stop.sessionStopped, tool: schema.name }),
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

  const freshContract = readFreshContract(args.projectPath, browser, spawnedAt);
  const profileReused = profileReusedAt(carryover, freshContract?.profilePath, spawnedAt);

  if (profileReused !== carryover.reused) {
    markerWarning = registerSession({
      pid,
      browser,
      projectPath: args.projectPath,
      command,
      profileReused,
      headless: visibility.headless,
    });
  }

  const launch = await readLoadOverDebugPort(freshContract, productionLaunchEvidence(freshContract, allowControl));
  const launchSeen =
    launch.browserPid === null
      ? "the contract has not recorded a browser launch yet; extension_wait reads it once the build lands (browserPid, browserAlive)"
      : `the contract names the browser it launched (pid ${launch.browserPid}, ${launch.browserAlive ? "alive" : "gone"})`;

  const noBrowserOrHint = args.noBrowser ? "" : headlessHint(visibility.headless);
  const controlPort =
    typeof freshContract?.controlPort === "number" ? freshContract.controlPort : null;
  const controlledCopy =
    controlPort !== null && typeof freshContract?.distPath === "string"
      ? freshContract.distPath
      : `dist/extension-js/${browser}/controlled`;
  const bridgeLine = allowControl
    ? `${controlPort !== null ? `This production session carries the control channel (port ${controlPort})` : "This production session asked for the control channel, and the contract has not recorded its port yet because the build is still running; extension_wait reads it once the build lands. The channel rides"} on a copy of the build at ${controlledCopy}, so extension_storage, extension_reload (a real reload of the installed extension under open tabs, as a store update does), extension_open and extension_dom_snapshot attach${allowEval ? ", and extension_eval runs where the build's content_security_policy allows it (context:'page' in a tab always does)" : "; extension_eval needs allowEval:true"}. extension_logs has no console stream for it.`
    : "A production session carries no dev bridge, so extension_logs has no console stream for it and the control verbs cannot attach; pass allowControl:true to drive it.";

  return envelope({
    ok: true,
    command: schema.name,
    status: "started",
    value: {
      pid,
      browser,
      projectPath: args.projectPath,
      verb: command,
      ...(args.noBrowser ? {} : { profileReused }),
      observed: "the engine process was alive 5 s after it was spawned",
      headless: visibility.headless,
      allowControl,
      allowEval,
      ...(allowControl ? { controlPort } : {}),
      ...(identity.copyId ? { buildExtensionId: identity.plainId, controlledCopyId: identity.copyId } : {}),
      ...launch,
      ...(replaced.length > 0 ? { replacedSession: replaced[0] } : {}),
    },
    hint: launch.extensionLoaded === true
      ? `The engine's ${command} process was alive 5 s after spawn and ${launchSeen}, and ${browser} loaded the extension: ${launch.loadEvidence} ${bridgeLine} ${noBrowserOrHint} When you are done, call extension_stop to shut the session down.`
      : `The engine's ${command} process was alive 5 s after spawn and ${launchSeen}. What this answer cannot confirm is that ${browser} loaded the extension: ${launch.loadEvidence} ${bridgeLine} To prove the load, run it with extension_dev, whose answer carries guestLoaded. ${noBrowserOrHint} When you are done, call extension_stop to shut the session down.`,
    warnings: [
      profileReused && !args.noBrowser
        ? `${reusedProfileNote(freshContract?.profilePath ?? carryover.profilePath)}${identity.copyId ? ` That carry-over does not reach this controlled copy: its id ${launch.extensionId ?? identity.copyId} is its own, so its chrome.storage starts empty and it holds no grants from the plain build's runs.` : ""}`
        : null,
      ...identityWarnings(identity, launch.extensionId),
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
