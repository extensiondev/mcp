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
import { wwwNewPath } from "@extension.dev/urls/paths";

import { exactVersion } from "../lib/exec";
import { mcpOrigins } from "../lib/registry";
import { captureTemplateSeed } from "../lib/funnel-telemetry";
import { templateCatalogUrl } from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_create";

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
    "Create a browser extension project from a template in the extension.dev catalog. Call extension_templates first to see what is available. The scaffolder may initialize a git repository in the new project (with a first commit), and it also writes store metadata and a .gitignore of its own. Read the result's defaultsApplied block for the decisions this tool can read back: parent directory, template, package manager, target browser and whether a git repository was initialized by this call. After a successful scaffold this tool sends one telemetry event, draft_seeded (template slug, source and commit, a random install id, never a path or a name), to PostHog; the Telemetry section of this package's readme names the two environment variables that turn it off.",
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

const MANIFEST_SEARCH_DEPTH = 3;
const MANIFEST_SEARCH_SKIP = new Set(["node_modules", ".git"]);

export function findScaffoldManifest(projectPath: string): string | null {
  for (const rel of ["manifest.json", "src/manifest.json", "extension/manifest.json", "extension/src/manifest.json"]) {
    const candidate = path.join(projectPath, rel);
    if (fs.existsSync(candidate)) return candidate;
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }];

  while (queue.length) {
    const current = queue.shift() as { dir: string; depth: number };
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === "manifest.json") return path.join(current.dir, entry.name);

      if (entry.isDirectory() && current.depth < MANIFEST_SEARCH_DEPTH && !MANIFEST_SEARCH_SKIP.has(entry.name)) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return null;
}

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

  /* @invariant THE PROJECT'S OWN NAME IS NOT A NETWORK ERROR. The scaffolder
     logs a card with the name, template and path through this logger, so a
     project called network-monitor used to read as a transient fetch failure
    . The name and both paths are scrubbed before the
     markers are matched, and the thrown error's message is matched too. */
  const scrubbed = (text: string): string => {
    const noise = [args.projectName, projectInput, path.resolve(projectInput), args.parentDir ? path.resolve(args.parentDir) : ""]
      .filter((part) => part.length > 0)
      .sort((a, b) => b.length - a.length);

    return noise.reduce((acc, part) => acc.split(part).join(" "), text);
  };

  const looksTransient = (err?: unknown): boolean => {
    const message = err instanceof Error ? err.message : err === undefined ? "" : String(err);
    const blob = scrubbed([message, ...logLines].join("\n")).toLowerCase();

    return /timed out|timeout|etimedout|econnreset|rate limit|\b429\b|network|could not resolve host|terminal prompts disabled|authentication failed|early eof|rpc failed|remote end hung up/.test(
      blob,
    );
  };

  const gitBefore = fs.existsSync(path.join(path.resolve(projectInput), ".git"));
  /* @invariant Only a directory this call created fresh may ever be wiped:
     the scaffolder accepts pre-existing directories (dotfiles, LICENSE,
     node_modules, .git), and rmSync on one deletes files the tool never
     created. */
  const preExisting = fs.existsSync(projectInput);

  const cleanPartial = (): void => {
    if (preExisting) return;

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
    transient
      ? envelope({
          ok: false,
          command: COMMAND,
          status: "template-fetch-failed",
          error: {
            code: "E_TEMPLATE_FETCH",
            message:
              "Template download failed (network/timeout/rate-limit). This is not a bad template name. Retry, or check connectivity/GitHub rate limits.",
          },
          value: {
            cause: err instanceof Error ? err.message : String(err),
            duration: Date.now() - start,
            log: logTail(),
          },
        })
      : envelope({
          ok: false,
          command: COMMAND,
          status: "scaffold-failed",
          error: {
            code: "E_SCAFFOLD_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
          value: {
            duration: Date.now() - start,
            log: logTail(),
          },
        });

  let result: Awaited<ReturnType<typeof extensionCreate>>;

  try {
    result = await attempt();
  } catch (err1) {
    if (!looksTransient(err1)) return failure(err1, false);

    logLines.push("[retry] transient template-download failure; retrying once");
    cleanPartial();

    try {
      result = await attempt();
    } catch (err2) {
      return failure(err2, looksTransient(err2));
    }
  }

  /* @invariant THE MANIFEST IS FOUND THE WAY THE SCAFFOLDER FINDS IT: the
     four common locations, then a breadth-first walk to depth 3 skipping
     node_modules and .git (extension-create `findManifestJsonPath`). A
     monorepo template keeps it at packages/extension/src/manifest.json and
     used to be called incomplete. */
  const manifestPath = findScaffoldManifest(result.projectPath);

  if (!manifestPath) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "scaffold-incomplete",
      error: {
        code: "E_SCAFFOLD_INCOMPLETE",
        message: `The scaffold is incomplete: no manifest.json exists under ${result.projectPath} (checked the root, src/, extension/, extension/src/ and every directory to depth 3). Do not run extension_dev against it.`,
      },
      value: {
        projectPath: result.projectPath,
        duration: Date.now() - start,
        log: logTail(),
      },
      hint: "Delete the directory and retry extension_create; a template download interrupted mid-way can leave a partial tree.",
    });
  }

  /* @invariant The seed fires here and nowhere earlier: a scaffold with no
     manifest is a failed start, and counting it would put starts in the
     denominator that the funnel's other end can never reach. Discarded on
     purpose so no scaffold waits on it or dies with it. */
  void captureTemplateSeed({ slug: result.template, source: "template" });

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
    scaffoldPin !== null &&
    pin !== "" &&
    exactVersion(scaffoldPin) === exactVersion(pin);
  const engineWarning =
    pin && pin !== "latest" && !pinMatches
      ? `The scaffold pins "extension": "${scaffoldPin ?? "unknown"}"; the project-local engine wins over EXTENSION_MCP_CLI_VERSION=${pin}. Run \`(cd ${result.projectPath} && ${addDev(`extension@${pin}`)})\` to match the pinned engine.`
      : undefined;

  const resolvedParent = args.parentDir
    ? path.resolve(args.parentDir)
    : process.cwd();
  const gitInit = !gitBefore && fs.existsSync(path.join(result.projectPath, ".git"));

  const wwwOrigin = mcpOrigins().www;
  const deployUrl = `${wwwOrigin}${wwwNewPath({ template: result.template })}`;
  const catalogUrl = templateCatalogUrl(result.template, "mcp-create");

  return envelope({
    ok: true,
    command: COMMAND,
    status: "created",
    value: {
      resolvedPath: result.projectPath,
      projectPath: result.projectPath,
      manifestPath,
      projectName: result.projectName,
      template: result.template,
      templateCatalogUrl: catalogUrl,
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
    },
    warnings: [
      engineWarning,
      ...(result.depsInstalled ? [] : logTail()),
    ],
  });
}
