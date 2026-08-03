// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const DEFAULT_MEDIA_ORIGIN = "https://media.extension.land";
const DEFAULT_CHANNEL = "latest";

export const PINNED_COMMIT = "52c0d871c433d9c54878767175ce8ffc9a951756";

const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

function mediaOrigin(): string {
  return (process.env.EXTENSION_MEDIA_ORIGIN || "").trim() || DEFAULT_MEDIA_ORIGIN;
}

function channelName(): string {
  return (
    (process.env.EXTENSION_TEMPLATES_CHANNEL || "").trim() || DEFAULT_CHANNEL
  );
}

function pinnedCommitOverride(): string {
  return (process.env.EXTENSION_TEMPLATES_COMMIT || "").trim();
}

function rawBaseForCommit(commit: string): string {
  return `https://raw.githubusercontent.com/extension-js/examples/${commit}`;
}

type ResolvedRelease = {
  commit: string;
  metaUrl: string;
  filesBaseUrl: string;
};

let releaseCache: ResolvedRelease | null = null;
let releaseCacheExpiresAt = 0;
let releaseRequest: Promise<ResolvedRelease | null> | null = null;

function releaseForCommit(origin: string, commit: string): ResolvedRelease {
  return {
    commit,
    metaUrl: `${origin}/templates/${commit}/templates-meta.json`,
    filesBaseUrl: `${origin}/templates/${commit}/files`,
  };
}

async function resolveRelease(): Promise<ResolvedRelease | null> {
  const now = Date.now();
  if (releaseCache && now < releaseCacheExpiresAt) return releaseCache;
  if (releaseRequest) return releaseRequest;

  const origin = mediaOrigin();
  const override = pinnedCommitOverride();
  if (override) {
    releaseCache = releaseForCommit(origin, override);
    releaseCacheExpiresAt = now + CHANNEL_CACHE_TTL_MS;
    return releaseCache;
  }

  releaseRequest = (async () => {
    try {
      const pointerUrl = `${origin}/templates/${channelName()}.json`;
      const response = await fetch(pointerUrl, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const pointer = (await response.json()) as { commit?: string };
      const commit = String(pointer?.commit || "").trim();
      if (!commit) return null;
      releaseCache = releaseForCommit(origin, commit);
      releaseCacheExpiresAt = Date.now() + CHANNEL_CACHE_TTL_MS;
      return releaseCache;
    } catch {
      return null;
    }
  })();

  try {
    return await releaseRequest;
  } finally {
    releaseRequest = null;
  }
}

export async function templateMetaUrls(): Promise<string[]> {
  const urls: string[] = [];
  const release = await resolveRelease();
  if (release) urls.push(release.metaUrl);
  urls.push(`${rawBaseForCommit(PINNED_COMMIT)}/templates-meta.json`);
  return urls;
}

export function stripTemplatePathPrefix(
  slug: string,
  relativePath: string,
): string {
  for (const dir of ["public", "examples"]) {
    const prefix = `${dir}/${slug}/`;
    if (relativePath.startsWith(prefix)) return relativePath.slice(prefix.length);
  }
  return relativePath;
}

export async function templateFileUrls(
  slug: string,
  relativePath: string,
): Promise<string[]> {
  const relative = stripTemplatePathPrefix(slug, relativePath);
  const urls: string[] = [];
  const release = await resolveRelease();
  if (release) urls.push(`${release.filesBaseUrl}/${slug}/${relative}`);
  urls.push(`${rawBaseForCommit(PINNED_COMMIT)}/examples/${slug}/${relative}`);
  return urls;
}
