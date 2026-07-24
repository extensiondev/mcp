// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

// Resolves where the template corpus (catalog + per-file source) is fetched
// from. The owned media.extension.land origin is primary: it serves a
// content-addressed, sha256-verified release behind a channel pointer (the
// Expo EAS Update shape), so the MCP and intelligence.extension.dev resolve one
// pinned corpus instead of divergent floating refs (this package previously
// read the `nightly` release asset for the catalog and raw `main` for sources).
//
// The GitHub fallbacks are pinned to the SAME commit the media channel serves,
// so a media outage yields byte identical results. Bumps flip the channel
// pointer and this constant together.

const DEFAULT_MEDIA_ORIGIN = "https://media.extension.land";
const DEFAULT_CHANNEL = "latest";

// The commit the media `latest` channel points at. Keep in lockstep with
// apps/media.extension.land/scripts/build-templates-artifact.mjs.
const PINNED_COMMIT = "2d2ed9668cca002148d9eecd953a08b54d0bad9d";

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

// Ordered catalog URLs: media release first (channel-resolved), then the
// commit-pinned GitHub raw fallback.
export async function templateMetaUrls(): Promise<string[]> {
  const urls: string[] = [];
  const release = await resolveRelease();
  if (release) urls.push(release.metaUrl);
  urls.push(`${rawBaseForCommit(PINNED_COMMIT)}/templates-meta.json`);
  return urls;
}

// Ordered URLs for one source file: media release first, then commit-pinned raw.
export async function templateFileUrls(
  slug: string,
  relativePath: string,
): Promise<string[]> {
  const urls: string[] = [];
  const release = await resolveRelease();
  if (release) urls.push(`${release.filesBaseUrl}/${slug}/${relativePath}`);
  urls.push(
    `${rawBaseForCommit(PINNED_COMMIT)}/examples/${slug}/${relativePath}`,
  );
  return urls;
}
