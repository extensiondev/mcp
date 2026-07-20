// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { extensionCreate } from "extension-create";

// Map the lockfile the installer actually wrote to the package manager that
// owns it, so the run command we hand back matches what created node_modules
// (extension-create may pick bun/pnpm/yarn/npm depending on the environment).
function detectPackageManager(projectPath: string): string {
  const byLockfile: Array<[string, string]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, pm] of byLockfile) {
    if (fs.existsSync(path.join(projectPath, lockfile))) return pm;
  }
  return "npm";
}

export const schema = {
  name: "extension_create",
  description:
    "Create a new browser extension project from a template in the extension.dev template catalog. Use extension_list_templates to see available options.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectName: {
        type: "string",
        description: "Name of the extension project (used as directory name)",
      },
      parentDir: {
        type: "string",
        description:
          "Directory to create the project inside. Defaults to the MCP server's working directory, which may not be where you expect — pass this explicitly when you care where the project lands.",
      },
      template: {
        type: "string",
        default: "typescript",
        description:
          "Template slug from the extension.dev template catalog (e.g. 'react', 'ai-claude', 'content-vue'). Use extension_list_templates to discover options.",
      },
      install: {
        type: "boolean",
        default: true,
        description: "Install dependencies after creation",
      },
    },
    required: ["projectName"],
  },
};

export async function handler(args: {
  projectName: string;
  parentDir?: string;
  template?: string;
  install?: boolean;
}): Promise<string> {
  const start = Date.now();

  const projectInput = args.parentDir
    ? path.resolve(args.parentDir, args.projectName)
    : args.projectName;

  // A credential-helper prompt on the git pull go-git-it spawns for template
  // downloads is a top scaffold-failure trigger (it hangs to the timeout). Force
  // non-interactive git so the pull fails fast instead of hanging.
  process.env.GIT_TERMINAL_PROMPT = "0";
  if (process.env.GIT_ASKPASS === undefined) process.env.GIT_ASKPASS = "";

  // Capture the create/install output instead of discarding it, so a failed
  // install surfaces a diagnostic tail instead of failing silently.
  const logLines: string[] = [];
  const capture =
    (stream: "log" | "error") =>
    (...parts: any[]) => {
      const line = parts
        .map((p) => (typeof p === "string" ? p : String(p)))
        .join(" ")
        .trim();
      if (line) logLines.push(stream === "error" ? `[error] ${line}` : line);
    };
  const logTail = (max = 20): string[] => logLines.slice(-max);

  // A template download failing on a transient network/timeout/rate-limit is
  // surfaced by extension-create as "choose a valid template name". Detect that
  // so we retry once and report the real cause instead of blaming the slug.
  const looksTransient = (): boolean => {
    const blob = logLines.join("\n").toLowerCase();
    return /timed out|timeout|etimedout|econnreset|rate limit|\b429\b|network|could not resolve host|terminal prompts disabled|authentication failed|early eof|rpc failed|remote end hung up/.test(
      blob,
    );
  };
  const cleanPartial = (): void => {
    // A leftover partial target dir poisons a retry into the same name.
    try {
      if (args.parentDir && fs.existsSync(projectInput)) {
        fs.rmSync(projectInput, { recursive: true, force: true });
      }
    } catch {
    }
  };
  const attempt = () =>
    extensionCreate(projectInput, {
      template: args.template ?? "typescript",
      install: args.install ?? true,
      logger: { log: capture("log"), error: capture("error") },
    });
  const failure = (err: unknown, transient: boolean): string =>
    JSON.stringify({
      error: transient
        ? "Template download failed (network/timeout/rate-limit) — this is not a bad template name. Retry, or check connectivity/GitHub rate limits."
        : err instanceof Error
          ? err.message
          : String(err),
      ...(transient
        ? { cause: err instanceof Error ? err.message : String(err) }
        : {}),
      duration: Date.now() - start,
      log: logTail(),
    });

  let result: Awaited<ReturnType<typeof extensionCreate>>;
  try {
    result = await attempt();
  } catch (err1) {
    if (!looksTransient()) return failure(err1, false);
    logLines.push("[retry] transient template-download failure; retrying once");
    cleanPartial();
    try {
      result = await attempt();
    } catch (err2) {
      return failure(err2, looksTransient());
    }
  }

  const packageManager = result.depsInstalled
    ? detectPackageManager(result.projectPath)
    : "npm";
  const runDev = `${packageManager} run dev`;

  // The scaffold pins extension@latest, which beats EXTENSION_MCP_CLI_VERSION, so
  // the dev loop may run a different engine than the pinned CLI. Warn so callers
  // can reconcile (extension_doctor also flags the mismatch).
  const pin = String(process.env.EXTENSION_MCP_CLI_VERSION || "").trim();
  const engineWarning =
    pin && pin !== "latest"
      ? `The scaffold pins "extension": "latest"; the project-local engine wins over EXTENSION_MCP_CLI_VERSION=${pin}. Run \`(cd ${result.projectPath} && npm i -D extension@${pin})\` to match the pinned engine.`
      : undefined;

  return JSON.stringify({
    projectPath: result.projectPath,
    projectName: result.projectName,
    template: result.template,
    depsInstalled: result.depsInstalled,
    packageManager: result.depsInstalled ? packageManager : null,
    duration: Date.now() - start,
    nextSteps: result.depsInstalled
      ? [`cd ${result.projectPath}`, runDev]
      : [`cd ${result.projectPath}`, "npm install", "npm run dev"],
    ...(engineWarning ? { engineWarning } : {}),
    // Present only when install produced diagnostics worth seeing.
    ...(result.depsInstalled ? {} : { warnings: logTail() }),
  });
}
