// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TemplatesMetaV2, TemplateMeta } from "./types";
import { templateMetaUrls } from "./template-artifact-source";
import bundledSnapshot from "./templates-meta.snapshot.json";

const CACHE_DIR = path.join(os.homedir(), ".cache", "extension-js");
const CACHE_FILE = path.join(CACHE_DIR, "templates-meta.json");
const CACHE_TTL_MS = 60 * 60 * 1000;

function isUsableMeta(data: unknown): data is TemplatesMetaV2 {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as TemplatesMetaV2).templates) &&
    (data as TemplatesMetaV2).templates.length > 0
  );
}

function isCacheValid(): boolean {
  try {
    const stat = fs.statSync(CACHE_FILE);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function readCachedMeta(): TemplatesMetaV2 | null {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return isUsableMeta(cached) ? cached : null;
  } catch {
    return null;
  }
}

export type TemplatesSource = "live" | "cache" | "stale-cache" | "bundled-snapshot";

export interface TemplatesMetaRead {
  meta: TemplatesMetaV2;
  source: TemplatesSource;
  cacheAgeMs?: number;
  note?: string;
}

function cacheAgeMs(): number | undefined {
  try {
    return Date.now() - fs.statSync(CACHE_FILE).mtimeMs;
  } catch {
    return undefined;
  }
}

/* @invariant THE ANSWER NAMES ITS SOURCE, AND A GOOD LIVE READ IS NEVER
   THROWN AWAY OVER A CACHE WRITE. The cache write used to sit in the fetch's
   try, so an unwritable ~/.cache turned a live catalog into the bundled
   snapshot, and nothing said which source answered. */
export async function fetchTemplatesMetaWithSource(): Promise<TemplatesMetaRead> {
  if (isCacheValid()) {
    const cached = readCachedMeta();
    if (cached) return { meta: cached, source: "cache", cacheAgeMs: cacheAgeMs() };
  }

  const failures: string[] = [];
  for (const url of await templateMetaUrls()) {
    let data: unknown;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        failures.push(`${url} answered ${response.status}`);
        continue;
      }
      data = await response.json();
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isUsableMeta(data)) {
      failures.push(`${url} answered a body with no templates`);
      continue;
    }
    let note: string | undefined;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      fs.renameSync(tmpFile, CACHE_FILE);
    } catch (err) {
      note = `The live catalog was read but could not be cached under ${CACHE_DIR} (${err instanceof Error ? err.message : String(err)}); the next call fetches it again.`;
    }
    return { meta: data, source: "live", ...(note ? { note } : {}) };
  }

  const why = failures.length ? failures.join("; ") : "no catalog source is configured";
  const stale = readCachedMeta();
  if (stale) {
    const age = cacheAgeMs();
    return {
      meta: stale,
      source: "stale-cache",
      ...(age !== undefined ? { cacheAgeMs: age } : {}),
      note: `The catalog came from a cache older than its ${Math.round(CACHE_TTL_MS / 60000)} minute TTL${age !== undefined ? ` (${Math.round(age / 60000)} minutes)` : ""} because the live read failed (${why}); templates added or renamed since may be missing or stale.`,
    };
  }

  if (isUsableMeta(bundledSnapshot)) {
    return {
      meta: bundledSnapshot,
      source: "bundled-snapshot",
      note: `The catalog came from the snapshot bundled with this package because the live read failed (${why}); templates added or renamed since this package was published are missing or stale.`,
    };
  }

  throw new Error(`Failed to fetch templates-meta.json (${why}).`);
}

export async function fetchTemplatesMeta(): Promise<TemplatesMetaV2> {
  return (await fetchTemplatesMetaWithSource()).meta;
}

export interface TemplateFilters {
  surface?: string;
  framework?: string;
  tags?: string[];
  featured?: boolean;
  query?: string;
}

export async function listTemplatesWithSource(
  filters?: TemplateFilters,
): Promise<{ templates: TemplateMeta[]; source: TemplatesSource; note?: string }> {
  const read = await fetchTemplatesMetaWithSource();
  return {
    templates: applyTemplateFilters(read.meta.templates, filters),
    source: read.source,
    ...(read.note ? { note: read.note } : {}),
  };
}

export async function listTemplates(
  filters?: TemplateFilters,
): Promise<TemplateMeta[]> {
  const meta = await fetchTemplatesMeta();
  return applyTemplateFilters(meta.templates, filters);
}

function applyTemplateFilters(
  all: TemplateMeta[],
  filters?: TemplateFilters,
): TemplateMeta[] {
  let templates = all;

  if (filters?.surface) {
    templates = templates.filter((t) => t.surfaces.includes(filters.surface!));
  }

  if (filters?.framework !== undefined) {
    templates = templates.filter((t) => t.uiFramework === filters.framework);
  }

  if (filters?.tags?.length) {
    templates = templates.filter((t) =>
      filters.tags!.some(
        (tag) => t.tags?.includes(tag) || t.aiRecommendFor?.includes(tag),
      ),
    );
  }

  if (filters?.featured) {
    templates = templates.filter((t) => t.featured);
  }

  if (filters?.query) {
    const phrase = filters.query.toLowerCase().trim();
    const STOP = new Set([
      "the", "a", "an", "and", "or", "for", "with", "that", "this",
      "to", "of", "on", "in", "into", "your", "my", "me", "it", "is",
    ]);
    const tokens = phrase
      .split(/\s+/)
      .filter((tok) => tok.length >= 2 && !STOP.has(tok));

    const bodyOf = (t: TemplateMeta): string =>
      [
        t.description,
        ...(t.tags ?? []),
        ...(t.useCases ?? []),
        ...(t.aiPromptExamples ?? []),
      ]
        .join(" ")
        .toLowerCase();

    const scored = templates
      .map((t) => {
        const slug = t.slug.toLowerCase();
        const body = bodyOf(t);
        const hay = `${slug} ${body}`;
        let score = 0;
        if (phrase && hay.includes(phrase)) score += 100;
        for (const tok of tokens) {
          if (slug.includes(tok)) score += 3;
          else if (body.includes(tok)) score += 1;
        }
        return { t, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    templates = scored.map((entry) => entry.t);
  }

  return templates;
}

export async function getTemplateBySlug(
  slug: string,
): Promise<TemplateMeta | undefined> {
  const meta = await fetchTemplatesMeta();
  return meta.templates.find((t) => t.slug === slug);
}
