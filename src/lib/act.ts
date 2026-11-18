// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { runExtensionCli } from "./exec";
import { nameRefusedInjection } from "./injection-refusal";
import {
  outputFlagRefusalMessage,
  refusedTheOutputFlag,
} from "./engine-version";
import { knownSessionBrowsers, deadReadySession, resolveSessionBrowser } from "./session-browser";
import { productionSessionContext } from "./production-receipt";
import {
  answerAfterSafariWake,
  SAFARI_WAKE_WAIT_MS,
  safariExecutorUnavailable,
} from "./safari-background";
import {
  envelope,
  hintedAnswer,
  isEnvelope,
  type ErrorCode,
  reframedObject,
} from "./envelope";
import { withRefusalHint } from "./refusal-hints";
import { withRetry } from "./retry";

export function toMcpSpeak(text: string): string {
  return (
    text
      .replace(
        /`?extension dev(?: [^\s`]*)? --browser[= ]([\w-]+) --allow-control`?/g,
        'extension_dev with { browser: "$1" } (its control channel is on unless allowControl: false)',
      )
      .replace(/--allow-control/g, "allowControl (on by default on extension_dev, off only with allowControl: false)")
      .replace(/--allow-eval/g, "allowEval: true (extension_dev)")
      .replace(
        /Use --context page --tab <id>/g,
        'Use context: "page" (targets the active tab; pass url or tab to pick another)',
      )
      .replace(
        /--context[= ](background|popup|options|sidebar|devtools|newtab|history|bookmarks|content|page)\b/g,
        'context: "$1"',
      )
      .replace(/--tab[= ](\d+|<[\w-]+>)/g, "tab: $1")
      .replace(/--url[= ]"([^"]+)"/g, 'url: "$1"')
      .replace(/--url[= ](<[\w-]+>|\S*(?:\/\/|\*)\S*)/g, 'url: "$1"')
      .replace(
        /--browser[= ]([\w]+-based|chrome|chromium|edge|brave|opera|vivaldi|yandex|firefox|waterfox|librewolf|zen|floorp|safari)\b/g,
        'browser: "$1"',
      )
      .replace(/--timeout[= ](\d+)/g, "timeout: $1")
      .replace(
        /\bextension open (popup|options|sidebar|newtab|history|bookmarks)\b/g,
        'extension_open with surface: "$1"',
      )
      .replace(/`?extension inspect --list-tabs`?/g, "extension_dom_snapshot with listTabs: true")
      .replace(/`?extension inspect\b`?/g, "extension_inspect")
      .replace(/`?extension logs\b`?/g, "extension_logs")
      .replace(/`extension dev`/g, "extension_dev")
      .replace(/\bextension dev\b/g, "extension_dev")
      .replace(/--tab\b/g, "`tab`")
      .replace(/--url\b/g, "`url`")
      .replace(/--context\b/g, "`context`")
      .replace(/--browser\b/g, "`browser`")
      .replace(/--timeout\b/g, "`timeout`")
  );
}

const CONTROL_CHANNEL_DOWN_CODES = new Set([
  "E_CONTROL_DENIED",
  "E_CONTROL_UNAVAILABLE",
  "E_NO_CONTROL_CHANNEL",
  "E_NOT_ATTACHED",
  "E_SESSION_NOT_FOUND",
]);

function legacyControlChannelScrape(message: string): boolean {
  return /no active control channel|control channel refused|\b1006\b|no executor connected|is the session started with allowControl/i.test(
    message,
  );
}

const START_ONE_FIRST = / Run extension_dev with \{ browser: "[\w-]+" \} \(its control channel is on unless allowControl: false\) first\./;

function namesNoSession(message: string, code: string | undefined): boolean {
  return code ? code === "E_SESSION_NOT_FOUND" : /no active control channel/i.test(message);
}

/* @invariant "NO SESSION" NEVER SHARES A MESSAGE WITH "A SESSION RUNS".
 * The engine's refusal says no control channel was found and to run
 * extension_dev first, which is the whole truth only when the project has
 * no session. On 2026-11-18 a session that was still starting got that
 * sentence followed by "Active session browser(s) for this project:
 * chrome, pass that as browser", for a call that had asked for chrome
 * (ledger 922). When this server knows of a session, the sentence telling
 * the agent to start one is taken out: a session on the browser asked for
 * is told to wait on, and a session on another browser is named as the
 * one to pass.
 */
export function sessionNotFoundWords(
  message: string,
  command: string,
  asked: string | undefined,
  running: string[],
): { message: string; hint: string | null } {
  if (running.length === 0) return { message, hint: null };

  const told = message.replace(START_ONE_FIRST, "");

  if (asked && running.includes(asked)) {
    return {
      message: `${told} A ${asked} session is recorded for this project, so this is not a missing session: its control channel is not reachable yet, or it was started with allowControl: false.`,
      hint: `Call extension_wait with browser: "${asked}", then call ${command} again; extension_doctor names the leg that is down. Only a session started with allowControl: false needs extension_dev with replace: true.`,
    };
  }

  const others = running.filter((name) => name !== asked);

  return {
    message: `${told} This project's session runs on ${others.join(", ")}${asked ? `, not on ${asked}` : ""}.`,
    hint: `Call ${command} again with browser: "${others[0]}"${others.length > 1 ? ` (or one of: ${others.slice(1).join(", ")})` : ""}.`,
  };
}

function withSessionContext(
  message: string,
  projectPath: string,
  command: string,
  code?: string,
  browser?: string,
): { message: string; hint: string | null } {
  const isControlError = code
    ? CONTROL_CHANNEL_DOWN_CODES.has(code)
    : legacyControlChannelScrape(message);

  if (!isControlError) return { message, hint: null };

  const production = productionSessionContext(projectPath, browser ?? resolveSessionBrowser(projectPath, undefined).browser);
  if (production) return { message: `${message}\n${production}`, hint: null };

  const dead = deadReadySession(projectPath, browser);

  if (dead) {
    return {
      message: `${message}\nLikely cause: the dev server has exited, ${dead.browser} ready.json still says ready but its pid ${dead.pid} is dead. Restart with extension_dev (this is not an allowControl problem); extension_doctor confirms.`,
      hint: null,
    };
  }

  const running = knownSessionBrowsers(projectPath);
  if (running.length === 0) return { message, hint: null };
  if (namesNoSession(message, code)) return sessionNotFoundWords(message, command, browser, running);

  return {
    message: `${message} Active session browser(s) for this project: ${running.join(
      ", ",
    )}, pass that as \`browser\`, or restart it via extension_dev without allowControl: false if the control channel is off.`,
    hint: null,
  };
}

function browserFlag(args: string[]): string | undefined {
  const at = args.indexOf("--browser");

  return at !== -1 && typeof args[at + 1] === "string" ? args[at + 1] : undefined;
}

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);

  return at !== -1 && typeof args[at + 1] === "string" ? args[at + 1] : undefined;
}

function translateFrame(frame: any, projectPath: string, args: string[], command: string): any {
  if (!frame || frame.ok !== false) return frame;

  const browser = browserFlag(args);

  nameRefusedInjection(frame, { browser, url: flagValue(args, "--url") });

  let sessionHint: string | null = null;

  if (frame.error && typeof frame.error.message === "string") {
    const words = withSessionContext(
      toMcpSpeak(frame.error.message),
      projectPath,
      command,
      typeof frame.error.code === "string" ? frame.error.code : undefined,
      browser,
    );
    frame.error.message = words.message;
    sessionHint = words.hint;
  }

  if (sessionHint) {
    frame.error.hint = sessionHint;
  } else if (typeof frame.error?.hint === "string") {
    frame.error.hint = toMcpSpeak(frame.error.hint);
  }

  if (typeof frame.hint === "string") {
    frame.hint = toMcpSpeak(frame.hint);
  }

  return frame;
}

const TOOL_OWNING_VERB: Record<string, string> = {
  eval: "extension_eval",
  inspect: "extension_dom_snapshot",
  open: "extension_open",
  reload: "extension_reload",
  storage: "extension_storage",
};

function commandNamePerD6(verb: string, tool?: string): string {
  return tool ?? TOOL_OWNING_VERB[verb] ?? "extension_act";
}

const LEGACY_NAME_TO_CODE: Record<string, ErrorCode> = {
  BadRequest: "E_BAD_REQUEST",
  CliError: "E_CLI",
  NoSession: "E_NO_SESSION",
};

function wrapLegacyFrame(frame: any, command: string): Record<string, unknown> {
  const {
    ok,
    value,
    truncated,
    error,
    hint,
    note,
    notes,
    warning,
    ...extras
  } = frame as Record<string, unknown>;
  const raw = (error ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : undefined;
  const wrapped = reframedObject({
    ok: ok === true,
    command,
    status: ok === true ? "ok" : "failed",
    value: value === undefined ? null : value,
    error:
      ok === true
        ? null
        : {
            code:
              typeof raw.code === "string" && raw.code
                ? raw.code
                : (name && LEGACY_NAME_TO_CODE[name]) || "E_CLI",
            message:
              typeof raw.message === "string" ? raw.message : "command failed",
            ...(name ? { name } : {}),
            ...(raw.engine !== undefined
              ? { engine: raw.engine as string | null }
              : {}),
          },
    ...(truncated === true ? { truncated: true } : {}),
    ...(typeof hint === "string" ? { hint } : {}),
    warnings: [
      typeof note === "string" ? note : null,
      typeof warning === "string" ? warning : null,
      ...(Array.isArray(notes) ? notes.map((n) => String(n)) : []),
    ],
  });

  return { ...extras, ...wrapped };
}

export async function runActVerb(
  args: string[],
  projectPath: string,
  timeoutMs?: number,
  tool?: string,
  options: { wake?: boolean } = {},
): Promise<string> {
  const command = commandNamePerD6(args[0], tool);
  const separatorAt = args.indexOf("--");
  const cliArgs =
    separatorAt === -1
      ? [...args, "--output", "json"]
      : [
          ...args.slice(0, separatorAt),
          "--output",
          "json",
          ...args.slice(separatorAt),
        ];
  const { code, stdout, stderr, timedOut, signal } = await runExtensionCli(cliArgs, {
    cwd: projectPath,
    timeoutMs,
  });
  const out = stdout.trim();

  if (timedOut) {
    return envelope({
      ok: false,
      command,
      status: "cli-timeout",
      error: {
        code: "E_CLI",
        name: "CliTimeout",
        message: `This server stopped the extension CLI after ${timeoutMs ?? 30_000} ms (${signal ?? "a signal"}) before it answered. The ${args[0]} verb may already have acted; read the state it changes before repeating it.`,
        retry: "after-read",
      },
    });
  }

  if (out) {
    try {
      let frame = translateFrame(JSON.parse(out), projectPath, args, command);
      const browser = browserFlag(args);

      if (options.wake !== false && browser && safariExecutorUnavailable(frame, browser)) {
        frame = await answerAfterSafariWake(
          frame,
          projectPath,
          browser,
          async () => JSON.parse(await runActVerb(args, projectPath, timeoutMs, tool, { wake: false })),
          SAFARI_WAKE_WAIT_MS,
        );
      }

      if (isEnvelope(frame)) {
        frame.command = command;
        if (!Array.isArray(frame.warnings)) frame.warnings = [];
        if (frame.error) frame.error = frame.ok ? withRetry(frame.error, command, frame.value) : withRefusalHint(withRetry(frame.error, command, frame.value), command, frame.hint);

        return JSON.stringify(frame);
      }

      if (frame && typeof frame === "object") {
        return JSON.stringify(wrapLegacyFrame(frame, command));
      }
    } catch {
    }
  }

  if (refusedTheOutputFlag(stderr ?? "")) {
    return envelope({
      ok: false,
      command,
      status: "engine-too-old",
      error: {
        code: "E_ENGINE_TOO_OLD",
        name: "CliError",
        message: await outputFlagRefusalMessage("act", args[0], projectPath),
      },
      hint: "extension_doctor reports the project's engine version next to the one this server pins.",
    });
  }

  if (code === 0 && out) {
    return envelope({
      ok: false,
      command,
      status: "cli-unreadable",
      error: {
        code: "E_CLI",
        name: "CliUnreadable",
        message: `The extension CLI exited 0 but its answer could not be read as JSON (${out.slice(0, 200)}). The ${args[0]} verb may have acted; read the state it changes before repeating it.`,
        retry: "after-read",
      },
    });
  }

  const words = withSessionContext(
    toMcpSpeak(stderr.trim() || `extension exited with code ${code}`),
    projectPath,
    command,
    undefined,
    browserFlag(args),
  );

  return envelope({
    ok: false,
    command,
    status: "cli-failed",
    error: {
      code: "E_CLI",
      name: "CliError",
      message: words.message,
      ...(words.hint ? { hint: words.hint } : {}),
    },
  });
}

export function addWarning(frame: any, text: unknown): void {
  if (typeof text !== "string" || !text.trim()) return;
  if (!Array.isArray(frame.warnings)) frame.warnings = [];
  if (!frame.warnings.includes(text)) frame.warnings.push(text);
}

export function actFrameJson(frame: unknown): string {
  return hintedAnswer(JSON.stringify(frame));
}

function patchKeepingScalarResult(
  current: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return current === null || current === undefined
    ? { ...patch }
    : { result: current, ...patch };
}

export function patchValue(frame: any, patch: Record<string, unknown>): void {
  const current = frame.value;

  if (current && typeof current === "object" && !Array.isArray(current)) {
    Object.assign(current, patch);

    return;
  }

  frame.value = patchKeepingScalarResult(current, patch);
}

export interface ActArgs {
  projectPath: string;
  browser?: string;
  context?: string;
  url?: string;
  tab?: number;
  timeout?: number;
}

export function commonFlags(args: ActArgs): string[] {
  const flags: string[] = [];
  if (args.context) flags.push("--context", args.context);
  if (args.url) flags.push("--url", args.url);
  if (args.tab != null) flags.push("--tab", String(args.tab));
  if (args.browser) flags.push("--browser", args.browser);
  if (args.timeout != null) flags.push("--timeout", String(args.timeout));

  return flags;
}
