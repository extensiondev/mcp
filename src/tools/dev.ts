// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import path from "node:path";
import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";
import {
  browserExitStamp,
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
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";

  // Fork guard (swarm C5): a second dev call on the same projectPath used to
  // return ok:true while its browser died on the profile lock, leaving two
  // overlapping sessions. Detect a live session up front and either refuse or,
  // with replace:true, stop it first and say so.
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

  // allowEval is a superset of allowControl (eval can do anything the control
  // verbs can), so enabling eval must also open the control channel, otherwise
  // callers who pass allowEval:true hit silent refusals on storage/reload/open.
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
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const earlyOutput = spawned.readOutput();

  // Health tick before claiming "started". This used to report status:"started"
  // unconditionally after the fixed 3s wait, so a dev server that died on boot
  // (port taken, bad manifest, missing binary) still read as a healthy session,
  // and every later tool call then failed against a session that was never
  // alive. Report the death honestly, with the child's own output as evidence.
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
      output: denoiseEarlyOutput(earlyOutput).slice(0, 2000),
      logPath,
      hint:
        "Read `output` above for the cause: a port already in use, a manifest the build rejects, or a missing browser binary are the common ones. " +
        "Fix it and call extension_dev again; extension_doctor with this projectPath will also report what the last session recorded.",
    });
  }

  // A FAILED FIRST COMPILE leaves the dev server alive, so the process health
  // tick above cannot see it: the swarm caught 3 personas being told
  // status:"started" while the error sat buried in earlyOutput, then being
  // pointed onward to extension_wait against a session that would never serve
  // their extension. Surface it as the failure it is.
  const compileFailed = /compiled with errors|✖✖✖|ERROR in |Module not found|NOT FOUND/i.test(
    earlyOutput,
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
      output: denoiseEarlyOutput(earlyOutput).slice(0, 2000),
      logPath,
      hint: "Fix the compile error in `output` above and save: the dev server is still running and will recompile. Do not call extension_wait yet, it will report ready for a build that failed.",
    });
  }

  // The dev CLI surviving the tick does not mean the BROWSER did. A dead
  // browser leg used to ride an ok:true envelope, admitted only in
  // earlyOutput (swarm C5). Engines with the bug-71/72 fixes stamp ready.json
  // status:"error" code:"browser_exited" when their browser dies; a locked
  // profile (the known cause) also announces itself in the early output.
  const exitStamp = args.noBrowser
    ? null
    : browserExitStamp(args.projectPath, browser, spawnedAt);
  const profileLockHit =
    !args.noBrowser &&
    /SingletonLock|ProcessSingleton|profile[^\n]*(in use|locked)|already (open|running)/i.test(
      earlyOutput,
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
      output: denoiseEarlyOutput(earlyOutput).slice(0, 2000),
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

  return JSON.stringify({
    ok: true,
    pid,
    browser,
    port: args.port ?? 8080,
    projectPath: args.projectPath,
    status: "started",
    ...(replaced.length > 0
      ? {
          replacedSession: replaced[0],
          ...(replaced.length > 1 ? { replacedSessions: replaced } : {}),
        }
      : {}),
    capabilities,
    hint:
      "Use extension_wait to check when the extension is fully loaded, then extension_source_inspect to inspect the live state. " +
      (allowControl
        ? `Control channel is ON: extension_${controlVerbs.split(", ").join("/extension_")}${args.allowEval ? "/extension_eval" : ""} will work against this session.`
        : "Control channel is OFF: extension_storage/reload/open/dom_inspect need allowControl: true, and extension_eval needs allowEval: true (which also implies allowControl). To unlock them, call extension_dev again with the flag you need plus replace: true (it stops this session first); a plain second call is refused so the session does not fork.") +
      " When you are done, call extension_stop to shut down the dev server and browser.",
    earlyOutput: denoiseEarlyOutput(earlyOutput).slice(0, 500),
    logPath,
  });
}

// Drop benign package-manager chatter (e.g. npm's "Unknown project config
// auto-install-peers" warning, emitted because pnpm-style config lands in the
// ambient .npmrc) so earlyOutput carries signal, not noise. Real errors and
// the extension CLI's own progress lines are preserved.
function denoiseEarlyOutput(raw: string): string {
  const NOISE = [
    /^npm warn Unknown project config/i,
    /This will stop working in the next major version of npm/i,
    /^npm warn config/i,
    /V8: .*Invalid asm\.js/i,
    /^\(node:\d+\) V8:/i,
    /Use `node --trace-warnings/i,
  ];
  return raw
    .split("\n")
    .filter((line) => !NOISE.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trimStart();
}
