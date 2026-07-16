import { runExtensionCli } from "./exec";
import { knownSessionBrowsers } from "./session-browser";

/**
 * Translate CLI-speak in an error message into the MCP tool surface
 * (fresh-eyes walk, friction #2). The CLI's hints say things like
 * "Run `extension dev --browser=chromium --allow-control` first" — correct
 * for a human at a terminal, a dead end for an agent that only has the MCP
 * tools. Rewrite flags to their tool-argument names so the hint is actionable
 * on the surface the caller is actually using. Result data is never touched —
 * only error/hint prose.
 */
export function toMcpSpeak(text: string): string {
  return (
    text
      .replace(
        /`?extension dev(?: [^\s`]*)? --browser[= ]([\w-]+) --allow-control`?/g,
        'extension_dev with { browser: "$1", allowControl: true }',
      )
      .replace(/--allow-control/g, "allowControl: true (extension_dev)")
      .replace(/--allow-eval/g, "allowEval: true (extension_dev)")
      .replace(/--browser[= ]([\w-]+)/g, 'browser: "$1"')
      // Bare CLI command mentions left over after the flag rewrites.
      .replace(/`extension dev`/g, "extension_dev")
      .replace(/\bextension dev\b/g, "extension_dev")
  );
}

// The no-session error is the one place a wrong hint spawns a second,
// conflicting session — name the sessions that ARE running so the agent
// retargets instead of relaunching.
function withSessionContext(message: string, projectPath: string): string {
  if (!/no active control channel/i.test(message)) return message;
  const running = knownSessionBrowsers(projectPath);
  if (running.length === 0) return message;
  return `${message} Active session browser(s) for this project: ${running.join(
    ", ",
  )} — pass that as \`browser\`, or restart it via extension_dev with allowControl: true if the control channel is off.`;
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

/**
 * Run an `extension <verb> … --output json` act command and return its result
 * JSON as a string (the MCP tool payload). The CLI prints the control-channel
 * result frame to stdout (for ok and !ok alike); connection/no-session failures
 * go to stderr with a non-zero exit. Either way we return a JSON object.
 *
 * Per lockstep invariant #1 the act tools wrap the CLI verb rather than talking
 * to the control WS directly — so MCP behavior can never drift from the CLI.
 * Error PROSE is the one exception: hints are rewritten from CLI flags to MCP
 * tool arguments before returning (see toMcpSpeak).
 */
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
    // Validate it parses; pass ok frames through verbatim, translate error
    // prose on !ok frames.
    try {
      const frame = JSON.parse(out);
      if (frame && frame.ok === false) {
        return JSON.stringify(translateFrame(frame, projectPath));
      }
      return out;
    } catch {
      // fall through to the error shape
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

/** Shared input fields for act tools. */
export interface ActArgs {
  projectPath: string;
  browser?: string;
  context?: string;
  url?: string;
  tab?: number;
  timeout?: number;
}

/** Build the trailing CLI flags common to act verbs. */
export function commonFlags(args: ActArgs): string[] {
  const flags: string[] = [];
  if (args.context) flags.push("--context", args.context);
  if (args.url) flags.push("--url", args.url);
  if (args.tab != null) flags.push("--tab", String(args.tab));
  if (args.browser) flags.push("--browser", args.browser);
  if (args.timeout != null) flags.push("--timeout", String(args.timeout));
  return flags;
}
