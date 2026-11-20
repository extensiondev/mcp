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

export const ROOT_DIRECTORY_MAX_LENGTH = 512;
export const REF_MAX_LENGTH = 250;

export const ROOT_DIRECTORY_INVALID = `rootDirectory must be a relative path inside the repository, at most ${ROOT_DIRECTORY_MAX_LENGTH} characters with no '.' segment, double quote or control character`;

export const ROOT_DIRECTORY_WITH_UPLOAD =
  "rootDirectory applies to a repo source only; an uploaded folder is built from its own root, so point projectPath at that folder instead";

const ROOT_DIRECTORY_UNSAFE = /[\p{Cc}"]/u;

/* @invariant A ROOT DIRECTORY OR REF THE PLATFORM WOULD REFUSE IS REFUSED
 * HERE, BEFORE ANY APPROVAL IS ASKED, AND WHAT IS SENT IS WHAT THE PLATFORM
 * STORES. readRootDirectory follows www's parseRootDirectoryInput: backslashes
 * and repeated slashes become one slash, a leading './' and a trailing slash
 * are dropped, and an absolute path, a '.' or '..' segment, a double quote, a
 * control character or more than 512 characters is refused. readRef follows
 * git check-ref-format, which is what www's create door takes (ledger 1007,
 * 1010).
 */
export function readRootDirectory(value: unknown): { ok: true; rootDirectory: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, rootDirectory: "" };
  if (typeof value !== "string") return { ok: false };

  const raw = value.trim();
  if (!raw || raw === "." || raw === "./") return { ok: true, rootDirectory: "" };
  if (raw.length > ROOT_DIRECTORY_MAX_LENGTH || ROOT_DIRECTORY_UNSAFE.test(raw)) return { ok: false };
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) return { ok: false };

  const segments = raw
    .replace(/\\/g, "/")
    .replace(/^(\.\/+)+/, "")
    .split("/")
    .filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) return { ok: false };

  return { ok: true, rootDirectory: segments.join("/") };
}

export const REF_INVALID = `ref must be a branch, tag or full commit sha that git takes as a ref name: at most ${REF_MAX_LENGTH} characters with no spaces, '..', '//' or any of ~ ^ : ? * [ \\`;

export const REF_WITH_UPLOAD = "ref applies to a repo source only; an uploaded folder is built as it is, so leave ref out or name repo instead";

const REF_UNSAFE = /[\p{Cc}\s~^:?*[\\]|\.\.|\/\/|@\{/u;

export function readRef(value: unknown): { ok: true; ref: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, ref: "" };
  if (typeof value !== "string") return { ok: false };

  const ref = value.trim();
  if (!ref) return { ok: true, ref };

  const refused =
    ref.length > REF_MAX_LENGTH ||
    ref === "@" ||
    /^[-/]|[/.]$/.test(ref) ||
    REF_UNSAFE.test(ref) ||
    ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));

  return refused ? { ok: false } : { ok: true, ref };
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
  ref?: string;
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
      branch: source.kind === "github" ? String(args.ref || "").trim() : "",
      nodeVersion: "",
      runWhatsNew: false,
      runExtensionExecutables: false,
      ...(source.kind === "github" && args.rootDirectory ? { rootDirectory: args.rootDirectory } : {}),
    },
    ...origin,
    workspaceSlug: args.workspace,
  };
}
