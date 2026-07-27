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

// The CLI stamps these on a frame whose control channel is missing, refused or
// unattached; each one earns the same session narration as the prose match.
const CONTROL_CODES = new Set([
  "E_CONTROL_DENIED",
  "E_CONTROL_UNAVAILABLE",
  "E_NO_CONTROL_CHANNEL",
  "E_NOT_ATTACHED",
  "E_SESSION_NOT_FOUND",
]);

function withSessionContext(
  message: string,
  projectPath: string,
  code?: string,
): string {
  // The code decides whenever the frame carries one. The prose match below is
  // the fallback until every CLI stamps a code on its act frames.
  const isControlError = code
    ? CONTROL_CODES.has(code)
    : /no active control channel|control channel refused|\b1006\b|no executor connected|is the session started with allowControl/i.test(
        message,
      );
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

// The MCP tool name owns `command` (D6). A caller that has not been threaded
// through yet falls back to the tool that owns the CLI verb it ran.
const VERB_TOOL: Record<string, string> = {
  eval: "extension_eval",
  inspect: "extension_dom_snapshot",
  open: "extension_open",
  reload: "extension_reload",
  storage: "extension_storage",
};

// A legacy act frame carries a class name and no code, so the name is the only
// signal that maps a failure onto a stable code.
const LEGACY_CODES: Record<string, ErrorCode> = {
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
                : (name && LEGACY_CODES[name]) || "E_CLI",
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
  // The new CLI keeps a verb's own extras (inspect's `console`) beside the
  // envelope, so a wrapped legacy frame leaves them in the same place.
  return { ...extras, ...wrapped };
}

export async function runActVerb(
  args: string[],
  projectPath: string,
  timeoutMs?: number,
  tool?: string,
): Promise<string> {
  const command = tool ?? VERB_TOOL[args[0]] ?? "extension_act";
  const { code, stdout, stderr } = await runExtensionCli(
    [...args, "--output", "json"],
    { cwd: projectPath, timeoutMs },
  );
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

// A tool that annotates an act frame writes into the envelope's own slots:
// advisory prose joins `warnings`, detail keys go under `value`.
export function addWarning(frame: any, text: unknown): void {
  if (typeof text !== "string" || !text.trim()) return;
  if (!Array.isArray(frame.warnings)) frame.warnings = [];
  if (!frame.warnings.includes(text)) frame.warnings.push(text);
}

// A tool that annotated the CLI's own frame hands it back through here: act.ts
// owns the wire form of an act frame, so no tool hand-builds one.
export function actFrameJson(frame: unknown): string {
  return JSON.stringify(frame);
}

export function patchValue(frame: any, patch: Record<string, unknown>): void {
  const current = frame.value;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    Object.assign(current, patch);
    return;
  }
  // A verb whose value is a scalar (eval returns the expression's result) keeps
  // it under `result`, so annotating never drops the payload.
  frame.value =
    current === null || current === undefined
      ? { ...patch }
      : { result: current, ...patch };
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
