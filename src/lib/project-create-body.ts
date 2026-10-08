// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const DEFAULT_BUILD_COMMAND = "npm run build -- --browser <browser>";

export function buildCreateBody(args: {
  workspace: string;
  projectSlug: string;
  owner: string;
  repoName: string;
  installationId?: string;
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
      description: String(
        args.description ||
          `Browser extension project for ${args.owner}/${args.repoName}.`,
      ).trim(),
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
    github: {
      owner: args.owner,
      repo: args.repoName,
      installationId: args.installationId,
      createdAt: new Date().toISOString(),
      pullRequestComments: true,
      commitComments: false,
    },
    workspaceSlug: args.workspace,
    createdFrom: { kind: "repository", ref: `${args.owner}/${args.repoName}` },
  };
}
