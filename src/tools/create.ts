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

import { engineRefusal, exactVersion } from "../lib/exec";
import { resolveEngineOverride } from "../lib/engine-override";
import { captureTemplateSeed } from "../lib/funnel-telemetry";
import { pinnedTemplateCommit, templateCatalogUrl } from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";
import { shellPath } from "../lib/publish-link";
import { scaffoldScripts } from "../lib/scaffold-scripts";
import { detectPackageManager, writeScaffoldToolchainNote } from "../lib/store-md-toolchain";

const COMMAND = "extension_create";

const TEMPLATE_REF_ENV = "EXTENSION_CREATE_TEMPLATE_REF";

const SCAFFOLD_RECORD = ".extension-create.json";

let catalogPinHolders = 0;

async function withCatalogPin<T>(run: () => Promise<T>): Promise<T> {
  if (catalogPinHolders === 0 && process.env[TEMPLATE_REF_ENV]) return run();

  catalogPinHolders += 1;
  process.env[TEMPLATE_REF_ENV] = pinnedTemplateCommit();

  try {
    return await run();
  } finally {
    catalogPinHolders -= 1;
    if (catalogPinHolders === 0) delete process.env[TEMPLATE_REF_ENV];
  }
}

export function scaffoldSourceCommit(
  result: { projectPath: string; templateProvenance?: { ref?: string } },
): string | null {
  const own = result.templateProvenance?.ref;
  if (typeof own === "string" && own) return own;

  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(result.projectPath, SCAFFOLD_RECORD), "utf8"),
    ) as { ref?: unknown };

    return typeof record.ref === "string" && record.ref ? record.ref : null;
  } catch {
    return null;
  }
}

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

export const schema = {
  name: "extension_create",
  description:
    "Create an extension project from a template (extension_templates); it may init git. It is verified, so the next step is extension_dev, not a build; `scripts` name the outputs (`npm run build` writes dist/chromium). Sends one draft_seeded event; the readme's Telemetry section turns it off.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectName: {
        type: "string",
        description:
          "Project directory name. Alias: name.",
      },
      parentDir: {
        type: "string",
        description:
          "Where to create it; default the MCP server process cwd. Aliases: parent, into.",
      },
      template: {
        type: "string",
        default: "typescript",
        description:
          "Catalog slug, e.g. 'react'.",
      },
      install: {
        type: "boolean",
        default: true,
        description: "Install dependencies.",
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

  const requestedRef = process.env[TEMPLATE_REF_ENV] || pinnedTemplateCommit();
  const attempt = () =>
    withCatalogPin(() =>
      extensionCreate(projectInput, {
        template: args.template ?? "typescript",
        install: args.install ?? true,
        logger: { log: capture("log"), error: capture("error") },
      }),
    );
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

  void captureTemplateSeed({ slug: result.template, source: "template" });

  const packageManager =
    (result as { packageManager?: string }).packageManager ||
    (result.depsInstalled ? detectPackageManager(result.projectPath) : "npm");
  const runDev = `${packageManager} run dev`;
  const scripts = scaffoldScripts(result.projectPath, packageManager);
  const reviewerNoteToolchain = await writeScaffoldToolchainNote(result.projectPath, packageManager);
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
      ? `The scaffold pins "extension": "${scaffoldPin ?? "unknown"}"; the project-local engine wins over EXTENSION_MCP_CLI_VERSION=${pin}. Run \`(cd ${shellPath(result.projectPath)} && ${addDev(`extension@${pin}`)})\` to match the pinned engine.`
      : undefined;

  const resolvedParent = args.parentDir
    ? path.resolve(args.parentDir)
    : process.cwd();
  const gitInit = !gitBefore && fs.existsSync(path.join(result.projectPath, ".git"));

  const catalogUrl = templateCatalogUrl(result.template, "mcp-create");
  const catalogCommit = pinnedTemplateCommit();
  const sourceCommit = scaffoldSourceCommit(result) ?? requestedRef;
  const corpusWarning =
    sourceCommit !== catalogCommit
      ? `The scaffold came from extension-js/examples at ${sourceCommit} while extension_templates describes ${catalogCommit}, so what was read there can differ from what was written here. Unset ${TEMPLATE_REF_ENV} to scaffold from the catalog's commit.`
      : undefined;
  const refusal = engineRefusal();
  const overrideEnv = resolveEngineOverride()?.env ?? "EXTENSION_MCP_ENGINE_DIR";
  const openStep = refusal
    ? `Fix or unset ${overrideEnv} before extension_dev, extension_build or extension_start, which can only refuse until then: ${refusal} extension_doctor shows the paths it expects. Then ask the person "Want me to open it in Chrome so you can try it?" and, on yes, call extension_dev yourself (projectPath: ${result.projectPath}, headless: false).`
    : `Ask the person "Want me to open it in Chrome so you can try it?" and, on yes, call extension_dev yourself (projectPath: ${result.projectPath}, headless: false so they can see the window); its answer says when the session is ready. Do not hand the person a shell command to run it.`;

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
      sourceCommit,
      depsInstalled: result.depsInstalled,
      packageManager: result.depsInstalled ? packageManager : null,
      ship: {
        tool: "extension_project_create",
        needs: [
          "project: the new '<workspace>/<project>' on extension.dev",
          "repo: a GitHub '<owner>/<repo>' this scaffold is pushed to; today the platform builds from the pushed repository",
        ],
      },
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
          "chrome (default: extension_dev and extension_build target chrome and write dist/chrome unless you pass browser; the scaffolded scripts pass no --browser, so the engine runs them as chromium: scripts below names the folder each one writes)",
        gitInit,
      },
      scripts,
      ...(reviewerNoteToolchain ? { reviewerNoteToolchain } : {}),
      manualAlternative: `Outside an agent only: cd ${shellPath(result.projectPath)} && ${runDev}`,
      duration: Date.now() - start,
      nextSteps: [
        `The scaffold is complete and verified (manifest read at ${manifestPath}${result.depsInstalled ? ", dependencies installed" : ""}; template ${result.template} from extension-js/examples at ${sourceCommit}): it needs no build to check, so do not run a build to verify it.`,
        ...(result.depsInstalled
          ? []
          : [`Dependencies were not installed: run \`${packageManager} install\` in ${result.projectPath} first.`]),
        openStep,
        `To ship: extension_create scaffolds and runs locally, it does not host. When the person wants it on extension.dev, push this directory to a GitHub repository and call extension_project_create (project: '<workspace>/${result.projectName}', repo: '<owner>/<repo>'); it answers an approval URL first and the platform builds from the pushed repository. The www /new?template link makes an unrelated project from the pristine template, so never offer it as shipping this one.`,
      ],
    },
    warnings: [
      engineWarning,
      corpusWarning,
      ...(result.depsInstalled ? [] : logTail()),
    ],
  });
}
