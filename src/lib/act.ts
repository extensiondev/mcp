import { runExtensionCli } from "./exec";

/**
 * Run an `extension <verb> … --output json` act command and return its result
 * JSON as a string (the MCP tool payload). The CLI prints the control-channel
 * result frame to stdout (for ok and !ok alike); connection/no-session failures
 * go to stderr with a non-zero exit. Either way we return a JSON object.
 *
 * Per lockstep invariant #1 the act tools wrap the CLI verb rather than talking
 * to the control WS directly — so MCP behavior can never drift from the CLI.
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
    // Validate it parses; pass through verbatim if so.
    try {
      JSON.parse(out);
      return out;
    } catch {
      // fall through to the error shape
    }
  }
  return JSON.stringify({
    ok: false,
    error: {
      name: "CliError",
      message: stderr.trim() || `extension exited with code ${code}`,
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
