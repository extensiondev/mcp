// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { spawnExtensionCli } from "../lib/exec";
import { registerSession, removeSession } from "../lib/process-manager";
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
          "Enable extension_eval (runs code in a context; writes a 0600 session token). Implies allowControl, so a single allowEval: true also unlocks storage/reload/open/dom_inspect — you do not need to pass both.",
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
    allowControl?: boolean;
    allowEval?: boolean;
  } & LaunchFlagArgs,
): Promise<string> {
  const browser = args.browser ?? "chrome";
  // allowEval is a superset of allowControl (eval can do anything the control
  // verbs can), so enabling eval must also open the control channel — otherwise
  // callers who pass allowEval:true hit silent refusals on storage/reload/open.
  const allowControl = Boolean(args.allowControl || args.allowEval);
  const cliArgs = ["dev", args.projectPath, "--browser", browser];
  if (args.port !== undefined) cliArgs.push("--port", String(args.port));
  if (args.noBrowser) cliArgs.push("--no-browser");
  if (args.polyfill === false) cliArgs.push("--polyfill", "false");
  cliArgs.push(...launchFlagArgs(args));
  if (allowControl) cliArgs.push("--allow-control");
  if (args.allowEval) cliArgs.push("--allow-eval");

  const child = spawnExtensionCli(cliArgs, { projectDir: args.projectPath });
  const pid = child.pid!;

  registerSession({
    pid,
    browser,
    port: args.port,
    projectPath: args.projectPath,
    command: "dev",
  });
  child.on("exit", () => removeSession(args.projectPath, browser));

  let earlyOutput = "";
  const collector = (data: Buffer) => {
    earlyOutput += data.toString();
  };
  child.stdout?.on("data", collector);
  child.stderr?.on("data", collector);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  child.stdout?.off("data", collector);
  child.stderr?.off("data", collector);

  // Health tick before claiming "started". This used to report status:"started"
  // unconditionally after the fixed 3s wait, so a dev server that died on boot
  // (port taken, bad manifest, missing binary) still read as a healthy session —
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
      hint:
        "Read `output` above for the cause: a port already in use, a manifest the build rejects, or a missing browser binary are the common ones. " +
        "Fix it and call extension_dev again; extension_doctor with this projectPath will also report what the last session recorded.",
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
    capabilities,
    hint:
      "Use extension_wait to check when the extension is fully loaded, then extension_source_inspect to inspect the live state. " +
      (allowControl
        ? `Control channel is ON: extension_${controlVerbs.split(", ").join("/extension_")}${args.allowEval ? "/extension_eval" : ""} will work against this session.`
        : "Control channel is OFF: extension_storage/reload/open/dom_inspect need allowControl: true, and extension_eval needs allowEval: true (which also implies allowControl). Restart extension_dev with the flag you need.") +
      " When you are done, call extension_stop to shut down the dev server and browser.",
    earlyOutput: denoiseEarlyOutput(earlyOutput).slice(0, 500),
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
