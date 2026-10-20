// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROD_ORIGINS } from "@extension.dev/urls/origins";

import { mcpOrigins } from "./registry";

const DEFAULT_CATALOG_URL = `${PROD_ORIGINS.registry}/extension-dev/catalog/latest.json`;

const CATALOG_SCHEMA = "templates-catalog/v1";

export const PINNED_COMMIT = "8e2336852b51c0fb71fd03abeca1f5e93a44700e";

const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

function catalogPointerUrl(): string {
  return (process.env.EXTENSION_TEMPLATES_CATALOG_URL || "").trim() || DEFAULT_CATALOG_URL;
}

function pinnedCommitOverride(): string {
  return (process.env.EXTENSION_TEMPLATES_COMMIT || "").trim();
}

export function pinnedTemplateCommit(): string {
  return pinnedCommitOverride() || PINNED_COMMIT;
}

function rawBaseForCommit(commit: string): string {
  return `https://raw.githubusercontent.com/extension-js/examples/${commit}`;
}

function catalogDocumentUrl(pointerUrl: string, catalogPath: string): string {
  return new URL(catalogPath, pointerUrl).toString();
}

/* @invariant
 * A CATALOG CUT AT ANOTHER COMMIT IS REFUSED, NEVER SILENTLY SERVED.
 *
 * extension_create scaffolds from the engine's own copy of the pinned corpus,
 * and the template reads here hand the agent files from raw GitHub at the same
 * pin, so a catalog listing files at another commit would describe templates
 * the create tool does not scaffold. The registry channel pointer moves when
 * the templates app publishes, and this server never follows it on its own:
 * a pointer or a document naming another commit is dropped and the resolver
 * falls back to raw GitHub at the pin. The document's reason is returned as a
 * sentence so the tool's fallback note can carry both shas to the agent.
 */
export function isPinnedCatalog(payload: unknown): boolean {
  const document = payload as { schema?: unknown; source?: { commit?: unknown } } | null;
  if (document?.schema !== CATALOG_SCHEMA) return false;

  return String(document.source?.commit ?? "").trim() === pinnedTemplateCommit();
}

export function catalogCommitProblem(payload: unknown): string | null {
  const document = payload as {
    schema?: unknown;
    source?: { commit?: unknown };
  } | null;
  if (document?.schema !== CATALOG_SCHEMA) return null;

  const commit = String(document.source?.commit ?? "").trim();
  if (commit === pinnedTemplateCommit()) return null;

  return `the catalog document describes commit ${commit || "(none)"} while this package pins ${pinnedTemplateCommit()}`;
}

type ResolvedRelease = {
  commit: string;
  catalogUrl: string;
};

let releaseCache: ResolvedRelease | null = null;
let releaseCacheExpiresAt = 0;
let releaseRefusedUntil = 0;
let releaseRequest: Promise<ResolvedRelease | null> | null = null;

async function resolveRelease(): Promise<ResolvedRelease | null> {
  const now = Date.now();
  if (releaseCache && now < releaseCacheExpiresAt) return releaseCache;
  if (now < releaseRefusedUntil) return null;
  if (releaseRequest) return releaseRequest;

  const pointerUrl = catalogPointerUrl();
  const override = pinnedCommitOverride();

  if (override) {
    releaseCache = {
      commit: override,
      catalogUrl: catalogDocumentUrl(pointerUrl, `${override}.json`),
    };

    releaseCacheExpiresAt = now + CHANNEL_CACHE_TTL_MS;

    return releaseCache;
  }

  releaseRequest = (async () => {
    try {
      const response = await fetch(pointerUrl, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;

      const pointer = (await response.json()) as { commit?: string; catalog?: string };
      const commit = String(pointer?.commit || "").trim();
      if (!commit) return null;

      if (commit !== PINNED_COMMIT) {
        process.stderr.write(
          `[extension-mcp] the templates catalog pointer names commit ${commit} while this package pins ${PINNED_COMMIT}; reading the pinned corpus instead.\n`,
        );

        releaseRefusedUntil = Date.now() + CHANNEL_CACHE_TTL_MS;

        return null;
      }

      const catalogPath = String(pointer?.catalog || "").trim() || `${commit}.json`;
      releaseCache = {
        commit,
        catalogUrl: catalogDocumentUrl(pointerUrl, catalogPath),
      };

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

export type TemplateCatalogUtmSource = "mcp" | "mcp-create";

export function templateCatalogUrl(
  slug: string,
  utmSource: TemplateCatalogUtmSource = "mcp",
): string {
  const origin = mcpOrigins().templates.replace(/\/+$/, "");

  return `${origin}/${encodeURIComponent(slug)}?utm_source=${utmSource}&utm_medium=tool`;
}

export async function resolvedTemplateCommit(): Promise<string> {
  const release = await resolveRelease();

  return release?.commit || pinnedTemplateCommit();
}

export async function templateMetaUrls(): Promise<string[]> {
  const urls: string[] = [];
  const release = await resolveRelease();
  if (release) urls.push(release.catalogUrl);

  urls.push(`${rawBaseForCommit(pinnedTemplateCommit())}/templates-meta.json`);

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

  return [`${rawBaseForCommit(pinnedTemplateCommit())}/examples/${slug}/${relative}`];
}
