// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  LAUNCH_BROWSER,
  PROJECT_PATH,
} from "../lib/common-schema";
import {
  browserProfileRootDir,
  profileRemediation,
} from "../lib/session-paths";
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
import { envelope } from "../lib/envelope";
import {
  describeExtensionInvocation,
  spawnExtensionCli,
  spawnFailedEnvelope,
} from "../lib/exec";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import {
  contractBoundPort,
  contractControlState,
} from "../lib/session-browser";
import { guardSameBrowserSession } from "../lib/same-browser-session";
import { handler as waitHandler } from "./wait";
import { handler as logsHandler } from "./logs";
import {
  LAUNCH_FLAG_SCHEMA,
  headlessHint,
  headlessLaunch,
  launchFlagArgs,
  type LaunchFlagArgs,
} from "../lib/launch-flags";
import {
  SAFARI_DEV_OPTION_SCHEMA,
  isSafariTarget,
  notAttachedHint,
  safariDevOptionArgs,
  safariDevOptionRefusal,
  type SafariDevOptionArgs,
} from "../lib/safari-dev-options";
import { safariSigningFrame } from "../lib/safari-signing";
import {
  NO_ATTACH_DIAGNOSIS_NOTE,
  browserUpNotAttachedRelay,
} from "../lib/compiled-not-attached";

export const schema = {
  name: "extension_dev",
  description:
    "Run the extension while you edit it: dev build, hot module replacement, and a browser with the extension loaded. Reach for this first when the ask is \"run my extension\": by default it waits for the session to be ready and answers with the readiness and the first log lines, so one call covers the ask; pass wait:false to return as soon as the server is spawned. A dev session carries the control channel that extension_storage, extension_reload, extension_open and extension_dom_snapshot need (local, same machine, same user) unless you pass allowControl:false; the eval channel that extension_eval needs is the one gate that stays off until you pass allowEval:true (which implies control, so you never need to pass both). Use extension_start instead to run the production build in a browser. When the answer's ready.status is \"ready\" the session is up and nothing else needs calling before extension_logs, extension_inspect or the control verbs; extension_wait is only for wait:false, an answer whose ready.status was not ready, or a build-only session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: LAUNCH_BROWSER,
      port: {
        type: "number",
        description: "Dev server port (0 for auto-assign)",
      },
      noBrowser: {
        type: "boolean",
        default: false,
        description: "Start the dev server without launching a browser",
      },
      polyfill: {
        type: "boolean",
        default: true,
        description: "Apply cross-browser polyfill",
      },
      ...LAUNCH_FLAG_SCHEMA,
      ...SAFARI_DEV_OPTION_SCHEMA,
      replace: {
        type: "boolean",
        default: false,
        description:
          "Stop the live session this projectPath runs for the same browser first, reported as replacedSession. Without it a second call for that browser is refused rather than forking: one session per browser owns dist/<browser> and its ready.json and eval token. A session for another browser keeps running either way, since each browser has its own output, profile and port.",
      },
      allowControl: {
        type: "boolean",
        default: true,
        description:
          "The agent-bridge control channel that extension_storage/reload/open/dom_snapshot ride (local, same machine). On unless you pass false; eval is the gate that stays off (allowEval).",
      },
      wait: {
        type: "boolean",
        default: true,
        description:
          "Wait for the session to be ready before answering (the same contract extension_wait reads, up to 45s) and include the first log lines. false returns as soon as the server is spawned; call extension_wait and extension_logs yourself then.",
      },
      allowEval: {
        type: "boolean",
        default: false,
        description:
          "Enable extension_eval (runs code in a context; writes a 0600 session token). Implies allowControl, so you never need to pass both.",
      },
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
    polyfill?: boolean;
    replace?: boolean;
    allowControl?: boolean;
    allowEval?: boolean;
    wait?: boolean;
  } & LaunchFlagArgs &
    SafariDevOptionArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";

  const safariRefusal = safariDevOptionRefusal(schema.name, browser, args);
  if (safariRefusal) return safariRefusal;

  const guard = await guardSameBrowserSession({
    tool: schema.name,
    projectPath: args.projectPath,
    browser,
    replace: args.replace,
    hazard: `a second ${browser} session would overwrite them; the engine refuses one too.`,
    replacing: "the new one",
  });
  if ("refusal" in guard) return guard.refusal;

  const { replaced } = guard;

  const allowControl = args.allowControl !== false || Boolean(args.allowEval);
  const carryover = profileCarryoverBeforeLaunch(
    args.projectPath,
    browser,
    args.profile,
  );
  let profileReused = carryover.reused;
  const cliArgs = ["dev", args.projectPath, "--browser", browser];
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");
  if (args.polyfill === false) cliArgs.push("--polyfill", "false");

  cliArgs.push(...launchFlagArgs(args));
  cliArgs.push(...safariDevOptionArgs(args));
  if (allowControl) cliArgs.push("--allow-control");
  if (args.allowEval) cliArgs.push("--allow-eval");

  const visibility = headlessLaunch(args);
  const spawnedAt = Date.now();
  const spawned = spawnExtensionCli(cliArgs, {
    projectDir: args.projectPath,
    ...(visibility.env ? { env: visibility.env } : {}),
  });
  const { child, logPath } = spawned;

  if (child.pid === undefined) {
    return spawnFailedEnvelope(schema.name, spawned);
  }

  const pid = child.pid;

  const safariRecord = {
    ...(args.enableExtension ? { enableExtension: true } : {}),
    ...(args.developmentTeam ? { developmentTeam: args.developmentTeam } : {}),
    ...(args.appName ? { appName: args.appName } : {}),
  };

  let markerWarning = registerSession({
    pid,
    browser,
    port: args.port,
    projectPath: args.projectPath,
    command: "dev",
    noBrowser: Boolean(args.noBrowser),
    profileReused,
    headless: visibility.headless,
    logPath,
    ...safariRecord,
  });
  child.on("exit", () => {
    removeSession(args.projectPath, browser, pid);
    removeSessionMarker(args.projectPath, browser, pid);

  });

  const boot = await pollBootVerdict(args.projectPath, browser, {
    child,
    readOutput: spawned.readOutput,
    budgetMs: 3000,
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
          `The dev server exited during startup (${signal ? `signal ${signal}` : `exit code ${code}`}). ` +
          "No session is running, so extension_logs/wait/eval and the control verbs have nothing to attach to.",
      },
      value: {
        ...session,
        exitCode: code,
        signal,
        output: cleanOutput.slice(0, 2000),
        ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}),
      },
      hint:
        "Read `value.output` above for the cause: a port already in use, a manifest the build rejects, or a missing browser binary are the common ones. " +
        "Fix it and call extension_dev again; extension_doctor with this projectPath will also report what the last session recorded.",
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
          "The dev server started but the first compile failed, so the browser has nothing usable to load. The session is running; the extension is not.",
      },
      value: {
        ...session,
        compileErrors,
        ...(compileErrors.length ? {} : { output: cleanOutput.slice(0, 2000), ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}) }),
      },
      hint: "Fix the compile error listed in `value.compileErrors` and save: the dev server is still running and will recompile. extension_wait answers contract-error while the build is failed and ready once a compile lands.",
      warnings: boot.warnings,
    });
  }

  const usesManagedProfile =
    typeof args.profile !== "string" || args.profile.trim().length === 0;
  const profileRootDir = usesManagedProfile
    ? browserProfileRootDir(args.projectPath, browser)
    : null;
  const profileAdvice = profileRemediation({
    projectPath: args.projectPath,
    browser,
    profile: args.profile,
  });

  if (boot.verdict.kind === "profile-locked") {
    const { owner, lockedAt } = boot.verdict;

    return envelope({
      ok: false,
      command: schema.name,
      status: "profile-locked",
      error: {
        code: "E_PROFILE_LOCKED",
        message:
          boot.verdict.message ??
          `The dev server is running but the ${browser} browser it launched died during startup ` +
            `because its profile is locked by another browser instance${ 
            owner?.pid
              ? ` (pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ""})`
              : "" 
            }.`,
      },
      value: {
        ...session,
        ...(profileRootDir ? { profileRootDir } : {}),
        owner,
        ...(lockedAt ? { lockedAt } : {}),
        output: cleanOutput.slice(0, 2000),
        ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}),
      },
      hint:
        "A locked profile means another session's browser still holds it: call extension_stop with this projectPath to kill that session, then start extension_dev again. " +
        `If the lock survives a crash, clear it by hand before retrying. ${profileAdvice}`,
      warnings: boot.warnings,
    });
  }

  if (boot.verdict.kind === "browser-exited") {
    return envelope({
      ok: false,
      command: schema.name,
      status: "browser-exited",
      error: {
        code: "E_BROWSER_EXITED",
        message: `The dev server is running but the ${browser} browser it launched died during startup.`,
      },
      value: {
        ...session,
        ...boot.verdict.stamp,
        output: cleanOutput.slice(0, 2000),
        ...(cleanOutput.length > 2000 ? { outputTruncated: { shown: 2000, total: cleanOutput.length, kept: "head" } } : {}),
      },
      hint:
        "The browser process ended before the session attached; a locked profile is answered as profile-locked, not here. Read value.output and extension_logs for the browser's own last words; a binary that refuses the launch flags, a crash at startup or a browser killed from outside are the common causes. " +
        `Call extension_dev again; ${profileAdvice}`,
      warnings: boot.warnings,
    });
  }

  const readiness =
    args.wait === false || args.noBrowser ? null : await awaitReadyAndFirstLogs(args.projectPath, browser);
  const sessionReady = readiness?.ready.status === "ready";
  const readyProfilePath: unknown = readiness
    ? (readiness.ready as Record<string, unknown>).profilePath
    : undefined;
  const launchedProfile = readyProfilePath ?? carryover.profilePath;
  profileReused = profileReusedAt(carryover, readyProfilePath, spawnedAt);

  const controlVerbs = "storage, reload, open, dom_snapshot";
  const control = contractControlState(args.projectPath, browser, spawnedAt);
  const controlBound = allowControl && control.port !== null;
  const capabilities = {
    allowControl,
    allowEval: Boolean(args.allowEval),
    controlChannel: {
      requested: allowControl,
      port: control.port,
      ...(control.unavailableReason ? { unavailableReason: control.unavailableReason } : {}),
      ...(control.read ? {} : { note: "ready.json has not stamped the control port yet; extension_wait reports it once it lands." }),
    },
    unlocked: allowControl
      ? args.allowEval
        ? `${controlVerbs}, eval`
        : controlVerbs
      : "none (read-only: logs, inspect, wait, doctor)",
  };

  const boundPort = contractBoundPort(args.projectPath, browser, spawnedAt);

  if ((boundPort !== null && boundPort !== args.port) || profileReused !== carryover.reused) {
    markerWarning = registerSession({
      pid,
      browser,
      port: boundPort ?? args.port,
      projectPath: args.projectPath,
      command: "dev",
      noBrowser: Boolean(args.noBrowser),
      profileReused,
      headless: visibility.headless,
      logPath,
      ...safariRecord,
    });
  }

  const signingFrame =
    readiness && (sessionReady || readiness.ready.status === "compiled-not-attached")
      ? await safariSigningFrame(args.projectPath, browser, {
          requested: args.developmentTeam,
          appName: args.appName,
          logPath,
          sessionPid: pid,
        })
      : null;

  const portReport =
    boundPort !== null
      ? {
          port: boundPort,
          ...(args.port !== undefined && args.port !== boundPort
            ? { requestedPort: args.port }
            : {}),
        }
      : { requestedPort: args.port ?? 8080 };
  const autoAssigned = args.port === 0;
  const portNote =
    boundPort !== null
      ? args.port !== undefined && args.port !== boundPort
        ? autoAssigned
          ? `Port 0 asked the engine for any free port and it picked ${boundPort} (read from the engine's ready.json contract, the same source extension_wait reports).`
          : `Requested port ${args.port} was not available; the dev server bound ${boundPort} (read from the engine's ready.json contract, the same source extension_wait reports).`
        : null
      : autoAssigned
        ? "Port 0 asked the engine for any free port, and it has not stamped its ready.json contract yet, so the port it picked is not known at response time. extension_wait reports it from that contract once it lands."
        : "The engine has not stamped its ready.json contract yet, so the bound port is not known at response time (a taken port makes the server bind the next free one). extension_wait reports the bound port from that contract once it lands; requestedPort above is only what was asked for.";

  const diagnosis = readiness ? browserUpNotAttachedRelay(readiness.ready) : null;

  if (diagnosis) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "compiled-not-attached",
      error: { code: "E_NOT_ATTACHED", message: diagnosis.message },
      value: {
        pid,
        browser,
        ...portReport,
        ...readiness,
        ...diagnosis.value,
        projectPath: args.projectPath,
        ...(replaced.length > 0 ? { replacedSession: replaced[0] } : {}),
        headless: visibility.headless,
        capabilities,
        engine: describeExtensionInvocation(args.projectPath),
        logPath,
      },
      warnings: [portNote, ...boot.warnings, markerWarning],
      hint: diagnosis.hint,
    });
  }

  const nextStep = sessionReady
    ? "The session is ready (ready.status: ready) and the first log lines are in firstLogs, so no extension_wait is needed: extension_inspect reads the live state and extension_logs the console."
    : readiness
      ? `ready.status is ${readiness.ready.status}, not ready: ${
          readiness.ready.status === "compiled-not-attached" && isSafariTarget(browser)
            ? notAttachedHint(browser, Boolean(args.enableExtension))
            : readiness.ready.status === "compiled-not-attached"
              ? `call extension_wait to keep waiting on the same contract, then extension_inspect to inspect the live state; ${NO_ATTACH_DIAGNOSIS_NOTE}.`
              : "call extension_wait to keep waiting on the same contract, then extension_inspect to inspect the live state."
        }`
      : "Use extension_wait to check when the extension is fully loaded, then extension_inspect to inspect the live state.";

  return envelope({
    ok: true,
    command: schema.name,
    status: "started",
    value: {
      pid,
      browser,
      ...(args.noBrowser ? {} : { profileReused }),
      ...portReport,
      ...(readiness ?? {}),
      projectPath: args.projectPath,
      ...(replaced.length > 0 ? { replacedSession: replaced[0] } : {}),
      ...(args.noBrowser ? {} : { headless: visibility.headless }),
      ...(signingFrame ? { signing: signingFrame.signing } : {}),
      capabilities,
      engine: describeExtensionInvocation(args.projectPath),
      logPath,
    },
    warnings: [
      profileReused && !args.noBrowser ? reusedProfileNote(launchedProfile) : null,
      portNote,
      ...boot.warnings,
      ...(signingFrame?.warnings ?? []),
      markerWarning,
    ],
    hint: args.noBrowser
      ? "Build-only session (noBrowser: true): no browser will launch, so no runtime will ever attach. extension_wait returns as soon as the first compile lands (compiled: true, browserAttached: false) instead of waiting out its budget; do not wait for a browser. The control verbs (storage/reload/open/dom_snapshot/eval) need a live browser and will not work against this session. When you are done, call extension_stop to shut down the dev server."
      : `${nextStep} ${signingFrame?.hints.length ? `${signingFrame.hints.join(" ")} ` : ""}${headlessHint(visibility.headless)} ${
        allowControl
          ? controlBound
            ? `Control channel is ON (port ${control.port} per ready.json): extension_${controlVerbs.split(", ").join("/extension_")}${args.allowEval ? "/extension_eval" : ""} will work against this session.`
            : control.unavailableReason
              ? `Control was requested, but the engine reports no control port (${control.unavailableReason}), so extension_${controlVerbs.split(", ").join("/extension_")} will be refused until the session is relaunched.`
              : `Control was requested; ready.json has not stamped the control port yet, so extension_wait is what confirms extension_${controlVerbs.split(", ").join("/extension_")} will work.`
          : "Control channel is OFF because this session was started with allowControl: false: extension_storage/reload/open/dom_snapshot are locked, and extension_eval needs allowEval: true. To unlock them, call extension_dev again without allowControl: false (plus allowEval: true for eval) and replace: true (it stops this session first); a plain second call is refused so the session does not fork."
        } When you are done, call extension_stop to shut down the dev server and browser.`,
  });
}

async function awaitReadyAndFirstLogs(projectPath: string, browser: string) {
  const ready = JSON.parse(await waitHandler({ projectPath, browser, timeoutMs: 45_000 })) as {
    status: string;
    value?: Record<string, unknown>;
  };
  const logs = JSON.parse(await logsHandler({ projectPath, browser, limit: 20 })) as {
    ok: boolean;
    status: string;
    value?: Record<string, unknown>;
  };

  const readyValue: Record<string, unknown> = { ...(ready.value ?? {}) };
  delete readyValue.signing;

  return {
    ready: { status: ready.status, ...readyValue },
    firstLogs: logs.ok ? (logs.value ?? {}) : { status: logs.status },
  };
}
