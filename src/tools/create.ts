// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { extensionCreate } from "extension-create";
import { mcpOrigins } from "../lib/registry";
import { wwwNewPath } from "@extension.dev/urls/paths";

function scaffoldEnginePin(projectPath: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectPath, "package.json"), "utf8"),
    );
    const spec =
      pkg?.devDependencies?.extension ?? pkg?.dependencies?.extension ?? null;
    return typeof spec === "string" ? spec : null;
  } catch {
    return null;
  }
}

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
    "Create a browser extension project from a template in the extension.dev catalog. Call extension_templates first to see what is available. The scaffolder may initialize a git repository in the new project. Read the result's defaultsApplied block for that, and for every other decision made without being asked.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectName: {
        type: "string",
        description:
          "Name of the extension project (used as directory name). Alias: name.",
      },
      parentDir: {
        type: "string",
        description:
          "Directory to create the project inside. Defaults to the MCP server process cwd, NOT the caller's cwd, so pass it whenever you care where the project lands. Aliases: parent, into.",
      },
      template: {
        type: "string",
        default: "typescript",
        description:
          "Template slug from the extension.dev catalog (e.g. 'react', 'ai-claude', 'content-vue'). extension_templates discovers them.",
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

  process.env.GIT_TERMINAL_PROMPT = "0";
  if (process.env.GIT_ASKPASS === undefined) process.env.GIT_ASKPASS = "";

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

  const looksTransient = (): boolean => {
    const blob = logLines.join("\n").toLowerCase();
    return /timed out|timeout|etimedout|econnreset|rate limit|\b429\b|network|could not resolve host|terminal prompts disabled|authentication failed|early eof|rpc failed|remote end hung up/.test(
      blob,
    );
  };
  const cleanPartial = (): void => {
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
        ? "Template download failed (network/timeout/rate-limit). This is not a bad template name. Retry, or check connectivity/GitHub rate limits."
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

  const hasManifest =
    fs.existsSync(path.join(result.projectPath, "manifest.json")) ||
    fs.existsSync(path.join(result.projectPath, "src", "manifest.json"));
  if (!hasManifest) {
    return JSON.stringify({
      ok: false,
      status: "incomplete",
      projectPath: result.projectPath,
      error: `The scaffold is incomplete: no manifest.json exists under ${result.projectPath} (checked the root and src/). Do not run extension_dev against it.`,
      duration: Date.now() - start,
      log: logTail(),
      hint: "Delete the directory and retry extension_create; a template download interrupted mid-way can leave a partial tree.",
    });
  }

  const packageManager =
    (result as { packageManager?: string }).packageManager ||
    (result.depsInstalled ? detectPackageManager(result.projectPath) : "npm");
  const runDev = `${packageManager} run dev`;
  const addDev = (spec: string): string =>
    packageManager === "npm"
      ? `npm i -D ${spec}`
      : packageManager === "yarn"
        ? `yarn add -D ${spec}`
        : `${packageManager} add -D ${spec}`;

  const pin = String(process.env.EXTENSION_MCP_CLI_VERSION || "").trim();
  const scaffoldPin = scaffoldEnginePin(result.projectPath);
  const pinMatches =
    scaffoldPin !== null && pin !== "" && scaffoldPin.includes(pin);
  const engineWarning =
    pin && pin !== "latest" && !pinMatches
      ? `The scaffold pins "extension": "${scaffoldPin ?? "unknown"}"; the project-local engine wins over EXTENSION_MCP_CLI_VERSION=${pin}. Run \`(cd ${result.projectPath} && ${addDev(`extension@${pin}`)})\` to match the pinned engine.`
      : undefined;

  const resolvedParent = args.parentDir
    ? path.resolve(args.parentDir)
    : process.cwd();
  const gitInit = fs.existsSync(path.join(result.projectPath, ".git"));

  const wwwOrigin = mcpOrigins().www;
  const deployUrl = `${wwwOrigin}${wwwNewPath({ template: result.template })}`;

  return JSON.stringify({
    resolvedPath: result.projectPath,
    projectPath: result.projectPath,
    projectName: result.projectName,
    template: result.template,
    depsInstalled: result.depsInstalled,
    packageManager: result.depsInstalled ? packageManager : null,
    deployUrl,
    defaultsApplied: {
      parentDir: args.parentDir
        ? `${resolvedParent} (explicit)`
        : `${resolvedParent} (default: the MCP server process cwd, not yours; pass parentDir to choose)`,
      ...(args.template === undefined
        ? {
            template:
              "typescript (default; call extension_templates to pick another, e.g. javascript for plain JS)",
          }
        : {}),
      packageManager: `${packageManager} (auto-detected by the scaffolder, not asked)`,
      browser:
        "chrome (default: extension_dev and extension_build target chrome unless you pass browser)",
      gitInit,
    },
    duration: Date.now() - start,
    nextSteps: [
      ...(result.depsInstalled
        ? [`cd ${result.projectPath}`, runDev]
        : [`cd ${result.projectPath}`, `${packageManager} install`, runDev]),
      `To ship: extension_create scaffolds and runs locally, it does not host. Open ${deployUrl} to deploy this template to the web.`,
    ],
    ...(engineWarning ? { engineWarning } : {}),
    ...(result.depsInstalled ? {} : { warnings: logTail() }),
  });
}
