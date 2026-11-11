// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const DEFAULT_BUILD_COMMAND = "npm run build -- --browser <browser>";

export type CreateBodySource =
  | { kind: "github"; owner: string; repoName: string; installationId?: string }
  | { kind: "upload"; uploadId: string };

export function buildCreateBody(args: {
  workspace: string;
  projectSlug: string;
  source: CreateBodySource;
  displayName?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  browsers?: string[];
  outputDirectories?: Record<string, unknown>;
}): Record<string, unknown> {
  const installCommand = String(args.installCommand || "npm install").trim();
  const buildCommand = String(args.buildCommand || DEFAULT_BUILD_COMMAND).trim();
  const wanted = new Set(
    (Array.isArray(args.browsers) && args.browsers.length
      ? args.browsers
      : ["chrome"]
    ).map((name) => String(name).trim().toLowerCase()),
  );
  const several = wanted.size > 1;

  const outputFor = (name: string) => {
    const override = args.outputDirectories?.[name];
    if (typeof override === "string" && override.trim()) return override.trim();

    const pattern = String(args.outputDirectory || "").trim();
    if (pattern.includes("<browser>")) return pattern.replaceAll("<browser>", name);
    if (pattern && !several) return pattern;

    return `dist/${name}`;
  };

  const source = args.source;
  const origin =
    source.kind === "github"
      ? {
          github: {
            owner: source.owner,
            repo: source.repoName,
            installationId: source.installationId,
            createdAt: new Date().toISOString(),
            pullRequestComments: true,
            commitComments: false,
          },
          createdFrom: { kind: "repository", ref: `${source.owner}/${source.repoName}` },
        }
      : {
          source: { uploadId: source.uploadId },
          createdFrom: { kind: "upload", ref: source.uploadId },
        };
  const describedAs =
    source.kind === "github"
      ? `Browser extension project for ${source.owner}/${source.repoName}.`
      : `Browser extension project ${args.projectSlug}.`;

  const browser = (name: string) => ({
    enabled: wanted.has(name),
    installCommand,
    buildCommand: buildCommand.replaceAll("<browser>", name),
    outputDirectory: outputFor(name),
  });

  return {
    info: {
      id: "",
      name: args.projectSlug,
      displayName: String(args.displayName || args.projectSlug).trim(),
      description: String(args.description || describedAs).trim(),
    },
    build: {
      chrome: browser("chrome"),
      edge: browser("edge"),
      firefox: browser("firefox"),
    },
    deployment: {
      branch: "",
      nodeVersion: "",
      runWhatsNew: false,
      runExtensionExecutables: false,
    },
    ...origin,
    workspaceSlug: args.workspace,
  };
}
