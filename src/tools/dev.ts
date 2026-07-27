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
import path from "node:path";
import { materializeCarrier, removeCarrier } from "../lib/carrier";
import { pollBootVerdict } from "../lib/boot-verdict";
import { envelope } from "../lib/envelope";
import { spawnExtensionCli, spawnFailedEnvelope } from "../lib/exec";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import {
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
    "Run the extension while you edit it: dev build, hot module replacement, and a browser with the extension loaded. Reach for this first when the ask is \"run my extension\". ONLY this tool unlocks the control channel that extension_storage, extension_reload, extension_open and extension_dom_snapshot need (allowControl:true) and the eval channel that extension_eval needs (allowEval:true, which implies allowControl, so you never need to pass both). Use extension_start instead to run the production build in a browser. The result carries the process info that extension_wait and extension_inspect need.",
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
      replace: {
        type: "boolean",
        default: false,
        description:
          "Stop the live session for this projectPath first, reported as replacedSession. Without it a second call is refused rather than forking: two sessions fight over one profile and the newer browser dies on the lock.",
      },
      allowControl: {
        type: "boolean",
        default: false,
        description:
          "Enable the agent-bridge control channel that extension_storage/reload/open/dom_snapshot need",
      },
      allowEval: {
        type: "boolean",
        default: false,
        description:
          "Enable extension_eval (runs code in a context; writes a 0600 session token). Implies allowControl, so you never need to pass both.",
      },
      carrier: {
        type: "boolean",
        default: false,
        description:
          "Load the bundled Live Preview carrier beside your extension (Chromium only) so allowlisted pages (preview.extension.dev, localhost) can pair with the session and stream its real-lane chrome.* trace. Written into the auto-loaded ./extensions folder, gitignored, and removed on extension_stop or extension_build: never part of a release.",
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
      return envelope({
        ok: false,
        command: schema.name,
        status: "session-exists",
        error: {
          code: "E_SESSION_EXISTS",
          message:
            `A dev session is already running for this project (${listed}). ` +
            "Starting another would fork the session: both browsers contend for the same profile and the new one dies on the profile lock.",
        },
        value: {
          projectPath: args.projectPath,
          sessions: existing.map((s) => ({ pid: s.pid, browser: s.browser })),
        },
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
  if (child.pid === undefined) {
    return spawnFailedEnvelope(schema.name, spawned);
  }
  const pid = child.pid;

  registerSession({
    pid,
    browser,
    port: args.port,
    projectPath: args.projectPath,
    command: "dev",
    noBrowser: Boolean(args.noBrowser),
  });
  /* @invariant
   * The carrier leaves when the session does, however the session ends.
   *
   * It is a debug companion with <all_urls>, cookies, history and management,
   * and the promise made about it is that it is never part of a release.
   * Removal used to live only in extension_stop and extension_build, so the
   * ordinary ways a dev session actually ends, closing the browser, a crash, a
   * kill, left it sitting in the auto-loaded ./extensions folder for the next
   * build to pick up. Tying removal to the child's exit covers every one of
   * those, and removeCarrier only touches a copy this server marked as its
   * own.
   */
  child.on("exit", () => {
    removeSession(args.projectPath, browser, pid);
    removeSessionMarker(args.projectPath, browser, pid);
    if (carrier) {
      try {
        removeCarrier(args.projectPath);
      } catch {
        // A carrier we cannot remove here is still refused by the build guard.
      }
    }
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
      },
      hint:
        "Read `value.output` above for the cause: a port already in use, a manifest the build rejects, or a missing browser binary are the common ones. " +
        "Fix it and call extension_dev again; extension_doctor with this projectPath will also report what the last session recorded.",
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
        ...(compileErrors.length ? {} : { output: cleanOutput.slice(0, 2000) }),
      },
      hint: "Fix the compile error listed in `value.compileErrors` and save: the dev server is still running and will recompile. Do not call extension_wait yet, it will report ready for a build that failed.",
      warnings: boot.warnings,
    });
  }

  const profileDir = path.join(
    args.projectPath,
    "dist",
    `extension-profile-${browser}`,
  );

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
            "because its profile is locked by another browser instance" +
            (owner?.pid
              ? ` (pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ""})`
              : "") +
            ".",
      },
      value: {
        ...session,
        profileDir,
        owner,
        ...(lockedAt ? { lockedAt } : {}),
        output: cleanOutput.slice(0, 2000),
      },
      hint:
        "A locked profile means another session's browser still holds it: call extension_stop with this projectPath to kill that session, then start extension_dev again. " +
        `If the lock survives a crash, remove ${profileDir} manually before retrying.`,
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
      },
      hint:
        "A locked profile means another session's browser still holds it: call extension_stop with this projectPath to kill that session, then start extension_dev again. " +
        `If the lock survives a crash, remove ${profileDir} manually before retrying.`,
      warnings: boot.warnings,
    });
  }

  const controlVerbs = "storage, reload, open, dom_snapshot";
  const capabilities = {
    allowControl,
    allowEval: Boolean(args.allowEval),
    unlocked: allowControl
      ? args.allowEval
        ? `${controlVerbs}, eval`
        : controlVerbs
      : "none (read-only: logs, inspect, wait, doctor)",
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
            ? { requestedPort: args.port }
            : {}),
        }
      : { requestedPort: args.port ?? 8080 };
  const portNote =
    boundPort !== null
      ? args.port !== undefined && args.port !== boundPort
        ? `Requested port ${args.port} was not available; the dev server bound ${boundPort} (read from the engine's ready.json contract, the same source extension_wait reports).`
        : null
      : "The engine has not stamped its ready.json contract yet, so the bound port is not known at response time (a taken port makes the server bind the next free one). extension_wait reports the bound port from that contract once it lands; requestedPort above is only what was asked for.";

  return envelope({
    ok: true,
    command: schema.name,
    status: "started",
    value: {
      pid,
      browser,
      ...portReport,
      projectPath: args.projectPath,
      ...(carrier ? { carrier } : {}),
      ...(replaced.length > 0
        ? {
            replacedSession: replaced[0],
            ...(replaced.length > 1 ? { replacedSessions: replaced } : {}),
          }
        : {}),
      capabilities,
      logPath,
    },
    warnings: [portNote, ...boot.warnings],
    hint: args.noBrowser
      ? "Build-only session (noBrowser: true): no browser will launch, so no runtime will ever attach. extension_wait returns as soon as the first compile lands (compiled: true, browserAttached: false) instead of waiting out its budget; do not wait for a browser. The control verbs (storage/reload/open/dom_snapshot/eval) need a live browser and will not work against this session. When you are done, call extension_stop to shut down the dev server."
      : "Use extension_wait to check when the extension is fully loaded, then extension_inspect to inspect the live state. " +
        (allowControl
          ? `Control channel is ON: extension_${controlVerbs.split(", ").join("/extension_")}${args.allowEval ? "/extension_eval" : ""} will work against this session.`
          : "Control channel is OFF: extension_storage/reload/open/dom_snapshot need allowControl: true, and extension_eval needs allowEval: true (which also implies allowControl). To unlock them, call extension_dev again with the flag you need plus replace: true (it stops this session first); a plain second call is refused so the session does not fork.") +
        " When you are done, call extension_stop to shut down the dev server and browser.",
  });
}
