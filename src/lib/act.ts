// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { runExtensionCli } from "./exec";
import { knownSessionBrowsers, deadReadySession } from "./session-browser";

export function toMcpSpeak(text: string): string {
  return (
    text
      .replace(
        /`?extension dev(?: [^\s`]*)? --browser[= ]([\w-]+) --allow-control`?/g,
        'extension_dev with { browser: "$1", allowControl: true }',
      )
      .replace(/--allow-control/g, "allowControl: true (extension_dev)")
      .replace(/--allow-eval/g, "allowEval: true (extension_dev)")
      // eval/inspect remediation speaks CLI flags; rewrite to MCP JSON args.
      .replace(/--context[= ]([\w-]+)/g, 'context: "$1"')
      .replace(/--tab[= ](\d+)/g, "tab: $1")
      .replace(/--url[= ](\S+)/g, 'url: "$1"')
      .replace(/--browser[= ]([\w-]+)/g, 'browser: "$1"')
      .replace(/`extension dev`/g, "extension_dev")
      .replace(/\bextension dev\b/g, "extension_dev")
  );
}

function withSessionContext(message: string, projectPath: string): string {
  const isControlError =
    /no active control channel|control channel refused|\b1006\b|no executor connected|is the session started with allowControl/i.test(
      message,
    );
  if (!isControlError) return message;
  // The most common real cause of a dropped control channel is the dev server
  // having exited (a reload crash, a kill), which the "is allowControl set?"
  // text hides. Detect a ready.json with a dead pid and lead with that instead.
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

export async function runActVerb(
  args: string[],
  projectPath: string,
  timeoutMs?: number,
): Promise<string> {
  const { code, stdout, stderr } = await runExtensionCli(
    [...args, "--output", "json"],
    { cwd: projectPath, timeoutMs },
  );
  const out = stdout.trim();
  if (out) {
    try {
      const frame = JSON.parse(out);
      if (frame && frame.ok === false) {
        return JSON.stringify(translateFrame(frame, projectPath));
      }
      return out;
    } catch {
    }
  }
  const message = stderr.trim() || `extension exited with code ${code}`;
  return JSON.stringify({
    ok: false,
    error: {
      name: "CliError",
      message: withSessionContext(toMcpSpeak(message), projectPath),
    },
  });
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
