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

  try {
    const result = await extensionCreate(projectInput, {
      template: args.template ?? "typescript",
      install: args.install ?? true,
      logger: { log: capture("log"), error: capture("error") },
    });

    const packageManager = result.depsInstalled
      ? detectPackageManager(result.projectPath)
      : "npm";
    const runDev = `${packageManager} run dev`;

    return JSON.stringify({
      projectPath: result.projectPath,
      projectName: result.projectName,
      template: result.template,
      depsInstalled: result.depsInstalled,
      packageManager: result.depsInstalled ? packageManager : null,
      duration: Date.now() - start,
      nextSteps: result.depsInstalled
        ? [`cd ${result.projectPath}`, runDev]
        : [
            `cd ${result.projectPath}`,
            "npm install",
            "npm run dev",
          ],
      // Present only when install produced diagnostics worth seeing.
      ...(result.depsInstalled ? {} : { warnings: logTail() }),
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
      // The failure detail lived in the swallowed logger; hand back a tail.
      log: logTail(),
    });
  }
}
