// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type CreateBodySource =
  | { kind: "github"; owner: string; repoName: string; installationId?: string }
  | { kind: "upload"; uploadId: string };

export const ROOT_DIRECTORY_INVALID = "rootDirectory must be a relative path inside the repository";

export const ROOT_DIRECTORY_WITH_UPLOAD =
  "rootDirectory applies to a repo source only; an uploaded folder is built from its own root, so point projectPath at that folder instead";

export function readRootDirectory(value: unknown): { ok: true; rootDirectory: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, rootDirectory: "" };
  if (typeof value !== "string") return { ok: false };

  const raw = value.trim();
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) return { ok: false };

  let rootDirectory = raw.replace(/^(\.\/)+/, "");

  while (rootDirectory.endsWith("/")) rootDirectory = rootDirectory.slice(0, -1);

  if (rootDirectory.split(/[\\/]/).some((segment) => segment === "..")) return { ok: false };

  return { ok: true, rootDirectory: rootDirectory === "." ? "" : rootDirectory };
}

export function rootDirectoryOf(value: unknown): string {
  const read = readRootDirectory(value);

  return read.ok ? read.rootDirectory : "";
}

export function buildCreateBody(args: {
  workspace: string;
  projectSlug: string;
  source: CreateBodySource;
  rootDirectory?: string;
  displayName?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  browsers?: string[];
  outputDirectories?: Record<string, unknown>;
}): Record<string, unknown> {
  const installCommand = String(args.installCommand || "").trim();
  const buildCommand = String(args.buildCommand || "").trim();
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
      ...(source.kind === "github" && args.rootDirectory ? { rootDirectory: args.rootDirectory } : {}),
    },
    ...origin,
    workspaceSlug: args.workspace,
  };
}
