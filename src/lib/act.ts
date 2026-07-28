// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { runExtensionCli } from "./exec";
import {
  outputFlagRefusalMessage,
  refusedTheOutputFlag,
} from "./engine-version";
import { knownSessionBrowsers, deadReadySession } from "./session-browser";
import {
  envelope,
  envelopeObject,
  isEnvelope,
  type ErrorCode,
} from "./envelope";

export function toMcpSpeak(text: string): string {
  return (
    text
      .replace(
        /`?extension dev(?: [^\s`]*)? --browser[= ]([\w-]+) --allow-control`?/g,
        'extension_dev with { browser: "$1", allowControl: true }',
      )
      .replace(/--allow-control/g, "allowControl: true (extension_dev)")
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
        /--browser[= ]([\w]+-based|chrome|chromium|edge|brave|opera|vivaldi|yandex|firefox|waterfox|librewolf|safari)\b/g,
        'browser: "$1"',
      )
      .replace(/--timeout[= ](\d+)/g, "timeout: $1")
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

/* @invariant The prose match reached when there is no code to read, which is
   two situations and only one of them is about an old engine.

   From 4.0.17 the CLI's act layer stamps a code on every failing frame, and the
   control-channel ones land in the set above: E_SESSION_NOT_FOUND when no ready
   contract exists, E_CONTROL_DENIED for a 40xx close, E_CONTROL_UNAVAILABLE for
   a handshake that never completed. An engine at or above that floor never
   reaches this function through translateFrame. The floor is days old, though,
   and this server drives whatever binary the project has in node_modules/.bin,
   so a 3.x or early-4.x project is an ordinary thing to meet and the scrape is
   what keeps its errors legible.

   The second situation does not expire with any version. When the CLI writes
   nothing parseable to stdout, runActVerb builds its own frame out of stderr,
   and stderr is text: there is no code on it to consult, whatever engine
   produced it. So this stays after the version argument is gone, and it is
   deliberately matched against the engine's message and not the CLI's decorated
   copy, which is why it trips none of the tokens no-prose-scraping bans. */
function legacyControlChannelScrape(message: string): boolean {
  return /no active control channel|control channel refused|\b1006\b|no executor connected|is the session started with allowControl/i.test(
    message,
  );
}

function withSessionContext(
  message: string,
  projectPath: string,
  code?: string,
): string {
  const isControlError = code
    ? CONTROL_CHANNEL_DOWN_CODES.has(code)
    : legacyControlChannelScrape(message);
  if (!isControlError) return message;
  const dead = deadReadySession(projectPath);
  if (dead) {
    return `${message}\nLikely cause: the dev server has exited, ${dead.browser} ready.json still says ready but its pid ${dead.pid} is dead. Restart with extension_dev (this is not an allowControl problem); extension_doctor confirms.`;
  }
  const running = knownSessionBrowsers(projectPath);
  if (running.length === 0) return message;
  return `${message} Active session browser(s) for this project: ${running.join(
    ", ",
  )}, pass that as \`browser\`, or restart it via extension_dev with allowControl: true if the control channel is off.`;
}

function translateFrame(frame: any, projectPath: string): any {
  if (!frame || frame.ok !== false) return frame;
  if (frame.error && typeof frame.error.message === "string") {
    frame.error.message = withSessionContext(
      toMcpSpeak(frame.error.message),
      projectPath,
      typeof frame.error.code === "string" ? frame.error.code : undefined,
    );
  }
  if (typeof frame.error?.hint === "string") {
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
  const wrapped = envelopeObject({
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
  const { code, stdout, stderr } = await runExtensionCli(cliArgs, {
    cwd: projectPath,
    timeoutMs,
  });
  const out = stdout.trim();
  if (out) {
    try {
      const frame = translateFrame(JSON.parse(out), projectPath);
      if (isEnvelope(frame)) {
        frame.command = command;
        if (!Array.isArray(frame.warnings)) frame.warnings = [];
        return JSON.stringify(frame);
      }
      if (frame && typeof frame === "object") {
        return JSON.stringify(wrapLegacyFrame(frame, command));
      }
    } catch {
    }
  }
  /* @invariant Diagnose the refusal only once it has happened.
   *
   * `build` probes the version BEFORE it runs, because discovering the floor by
   * watching a refusal costs it a second compile. Nothing here compiles: an act
   * verb that is refused its flag has exited without touching the session, so
   * the probe buys no time and would instead put an extra exec in front of every
   * eval, open, reload and storage call on every engine, to serve a case that
   * only arises below the floor. Asking after the refusal costs a probe exactly
   * when the answer is needed, and the probe's own cache means a project that
   * keeps failing pays for one.
   */
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
  const message = stderr.trim() || `extension exited with code ${code}`;
  return envelope({
    ok: false,
    command,
    status: "cli-failed",
    error: {
      code: "E_CLI",
      name: "CliError",
      message: withSessionContext(toMcpSpeak(message), projectPath),
    },
  });
}

export function addWarning(frame: any, text: unknown): void {
  if (typeof text !== "string" || !text.trim()) return;
  if (!Array.isArray(frame.warnings)) frame.warnings = [];
  if (!frame.warnings.includes(text)) frame.warnings.push(text);
}

export function actFrameJson(frame: unknown): string {
  return JSON.stringify(frame);
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
