// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { runExtensionCli } from "./exec";
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

/** @deprecated Prose fallback until every CLI stamps a code on its act frames. */
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
