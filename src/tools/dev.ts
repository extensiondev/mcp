// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";
import { materializeCarrier } from "../lib/carrier";
import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";
import {
  browserExitStamp,
  contractBoundPort,
  liveProjectSessions,
} from "../lib/session-browser";
import { stopOne } from "./stop";
import {
  LAUNCH_FLAG_SCHEMA,
  launchFlagArgs,
  type LaunchFlagArgs,
} from "../lib/launch-flags";

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
        enum: ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "yandex", "firefox", "waterfox", "librewolf", "safari", "chromium-based", "gecko-based", "firefox-based", "webkit-based"],
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
      polyfill: {
        type: "boolean",
        default: true,
        description: "Apply cross-browser polyfill",
      },
      ...LAUNCH_FLAG_SCHEMA,
      replace: {
        type: "boolean",
        default: false,
        description:
          "Stop any live session already running for this projectPath before starting; the result then reports it as replacedSession. Without it, extension_dev refuses to start over a live session instead of silently forking it (two sessions fight over the browser profile and the newer browser dies on the profile lock).",
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
          "Enable extension_eval (runs code in a context; writes a 0600 session token). Implies allowControl, so a single allowEval: true also unlocks storage/reload/open/dom_inspect. You do not need to pass both.",
      },
      carrier: {
        type: "boolean",
        default: false,
        description:
          "Load the bundled Extension.dev Live Preview carrier beside your extension (Chromium-family browsers only). It is placed in the project's ./extensions folder, which Extension.js auto-loads; allowlisted pages (inspect.extension.dev, localhost) can then pair with the session and stream its real-lane chrome.* trace. Writes extensions/extension-dev-live-preview/ into the project, gitignores it, and takes it back out on extension_stop or extension_build: it is a debug companion, never part of a release.",
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
    carrier?: boolean;
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";

  const existing = liveProjectSessions(args.projectPath);
  const replaced: Array<{ pid: number; browser: string }> = [];
  if (existing.length > 0) {
    if (!args.replace) {
      const listed = existing
        .map((s) => `pid ${s.pid} (${s.browser})`)
        .join(", ");
      return JSON.stringify({
        ok: false,
        status: "session-exists",
        projectPath: args.projectPath,
        sessions: existing.map((s) => ({ pid: s.pid, browser: s.browser })),
        error:
          `A dev session is already running for this project (${listed}). ` +
          "Starting another would fork the session: both browsers contend for the same profile and the new one dies on the profile lock.",
        hint: "Call extension_stop with this projectPath first, or pass replace: true to have extension_dev stop the old session before starting the new one.",
      });
    }
    for (const s of existing) {
      await stopOne(args.projectPath, s.browser);
      replaced.push({ pid: s.pid, browser: s.browser });
    }
  }

  const carrier = args.carrier
    ? materializeCarrier(args.projectPath, browser)
    : null;

  const allowControl = Boolean(args.allowControl || args.allowEval);
  const cliArgs = ["dev", args.projectPath, "--browser", browser];
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");
  if (args.polyfill === false) cliArgs.push("--polyfill", "false");
  cliArgs.push(...launchFlagArgs(args));
  if (allowControl) cliArgs.push("--allow-control");
  if (args.allowEval) cliArgs.push("--allow-eval");

  const spawnedAt = Date.now();
  const spawned = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const { child, logPath } = spawned;
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    port: args.port,
    projectPath: args.projectPath,
    command: "dev",
    noBrowser: Boolean(args.noBrowser),
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const earlyOutput = spawned.readOutput();
  const cleanOutput = denoiseEarlyOutput(earlyOutput);

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
        `The dev server exited during startup (${signal ? `signal ${signal}` : `exit code ${code}`}). ` +
        "No session is running, so extension_logs/wait/eval and the control verbs have nothing to attach to.",
      output: cleanOutput.slice(0, 2000),
      logPath,
      hint:
        "Read `output` above for the cause: a port already in use, a manifest the build rejects, or a missing browser binary are the common ones. " +
        "Fix it and call extension_dev again; extension_doctor with this projectPath will also report what the last session recorded.",
    });
  }

  const compileFailed = /compiled with errors|✖✖✖|ERROR in |Module not found|NOT FOUND/i.test(
    cleanOutput,
  );
  if (compileFailed) {
    return JSON.stringify({
      ok: false,
      status: "compile-failed",
      projectPath: args.projectPath,
      browser,
      pid,
      error:
        "The dev server started but the FIRST COMPILE FAILED, so the browser has nothing usable to load. The session is running; the extension is not.",
      output: cleanOutput.slice(0, 2000),
      logPath,
      hint: "Fix the compile error in `output` above and save: the dev server is still running and will recompile. Do not call extension_wait yet, it will report ready for a build that failed.",
    });
  }

  const exitStamp = args.noBrowser
    ? null
    : browserExitStamp(args.projectPath, browser, spawnedAt);
  const profileLockHit =
    !args.noBrowser &&
    /SingletonLock|ProcessSingleton|profile[^\n]*(in use|locked)|already (open|running)/i.test(
      cleanOutput,
    );
  if (exitStamp || profileLockHit) {
    const profileDir = path.join(
      args.projectPath,
      "dist",
      `extension-profile-${browser}`,
    );
    return JSON.stringify({
      ok: false,
      status: "browser-exited",
      projectPath: args.projectPath,
      browser,
      pid,
      ...(exitStamp ?? {}),
      error:
        `The dev server is running but the ${browser} browser it launched died during startup` +
        (profileLockHit
          ? " because its profile is locked by another browser instance."
          : "."),
      output: cleanOutput.slice(0, 2000),
      logPath,
      hint:
        "A locked profile means another session's browser still holds it: call extension_stop with this projectPath to kill that session, then start extension_dev again. " +
        `If the lock survives a crash, remove ${profileDir} manually before retrying.`,
    });
  }

  const controlVerbs = "storage, reload, open, dom_inspect";
  const capabilities = {
    allowControl,
    allowEval: Boolean(args.allowEval),
    unlocked: allowControl
      ? args.allowEval
        ? `${controlVerbs}, eval`
        : controlVerbs
      : "none (read-only: logs, source_inspect, wait, doctor)",
  };

  const boundPort = contractBoundPort(args.projectPath, browser, spawnedAt);
  if (boundPort !== null && boundPort !== args.port) {
    registerSession({
      pid,
      browser,
      port: boundPort,
      projectPath: args.projectPath,
      command: "dev",
      noBrowser: Boolean(args.noBrowser),
    });
  }
  const portReport =
    boundPort !== null
      ? {
          port: boundPort,
          ...(args.port !== undefined && args.port !== boundPort
            ? {
                requestedPort: args.port,
                portNote: `Requested port ${args.port} was not available; the dev server bound ${boundPort} (read from the engine's ready.json contract, the same source extension_wait reports).`,
              }
            : {}),
        }
      : {
          requestedPort: args.port ?? 8080,
          portNote:
            "The engine has not stamped its ready.json contract yet, so the bound port is not known at response time (a taken port makes the server bind the next free one). extension_wait reports the bound port from that contract once it lands; requestedPort above is only what was asked for.",
        };

  return JSON.stringify({
    ok: true,
    pid,
    browser,
    ...portReport,
    projectPath: args.projectPath,
    status: "started",
    ...(carrier ? { carrier } : {}),
    ...(replaced.length > 0
      ? {
          replacedSession: replaced[0],
          ...(replaced.length > 1 ? { replacedSessions: replaced } : {}),
        }
      : {}),
    capabilities,
    hint: args.noBrowser
      ? "Build-only session (noBrowser: true): no browser will launch, so no runtime will ever attach. extension_wait returns as soon as the first compile lands (compiled: true, browserAttached: false) instead of waiting out its budget; do not wait for a browser. The control verbs (storage/reload/open/dom_inspect/eval) need a live browser and will not work against this session. When you are done, call extension_stop to shut down the dev server."
      : "Use extension_wait to check when the extension is fully loaded, then extension_source_inspect to inspect the live state. " +
        (allowControl
          ? `Control channel is ON: extension_${controlVerbs.split(", ").join("/extension_")}${args.allowEval ? "/extension_eval" : ""} will work against this session.`
          : "Control channel is OFF: extension_storage/reload/open/dom_inspect need allowControl: true, and extension_eval needs allowEval: true (which also implies allowControl). To unlock them, call extension_dev again with the flag you need plus replace: true (it stops this session first); a plain second call is refused so the session does not fork.") +
        " When you are done, call extension_stop to shut down the dev server and browser.",
    earlyOutput: cleanOutput.slice(0, 500),
    logPath,
  });
}

function denoiseEarlyOutput(raw: string): string {
  const NOISE = [
    /^npm warn Unknown project config/i,
    /This will stop working in the next major version of npm/i,
    /^npm warn config/i,
    /^npm warn exec/i,
    /The following package(s)? (was|were) not found and will be installed/i,
    /V8: .*Invalid asm\.js/i,
    /^\(node:\d+\) V8:/i,
    /Use `node --trace-warnings/i,
    /Invalid asm\.js:/i,
    /Linking failure in asm\.js/i,
    /Successfully compiled asm\.js/i,
  ];
  return raw
    .split("\n")
    .filter((line) => !NOISE.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trimStart();
}
