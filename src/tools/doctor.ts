import { runExtensionCli } from "../lib/exec";
import { toMcpSpeak } from "../lib/act";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_doctor",
  description:
    "Diagnose a dev session end-to-end: ready contract, dev-server process, control-port agreement, control channel, eval token, executor, and browser liveness. Returns one {check, status, detail, remediation?} entry per leg in dependency order — a 'skip' names the check that blocked it and is NOT a pass. Run this first when any act tool (storage/reload/eval/open) errors unexpectedly. Wraps `extension doctor`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        description:
          "Browser session to diagnose. Defaults to the active dev session's browser for this project.",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
}): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const { code, stdout, stderr } = await runExtensionCli(
    ["doctor", args.projectPath, "--browser", browser, "--output", "json"],
    { cwd: args.projectPath },
  );

  const out = stdout.trim();
  try {
    const checks = JSON.parse(out);
    if (!Array.isArray(checks)) throw new Error("not a check array");
    for (const check of checks) {
      if (typeof check.detail === "string") check.detail = toMcpSpeak(check.detail);
      if (typeof check.remediation === "string") {
        check.remediation = toMcpSpeak(check.remediation);
      }
    }
    return JSON.stringify({ browser, healthy: code === 0, checks });
  } catch {
    const message = stderr.trim() || `extension exited with code ${code}`;
    return JSON.stringify({
      ok: false,
      error: {
        name: "CliError",
        message: toMcpSpeak(message),
        hint: "extension doctor requires a recent extension CLI — the project's local install may predate it.",
      },
    });
  }
}
