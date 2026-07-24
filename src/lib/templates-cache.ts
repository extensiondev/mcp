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

const CACHE_DIR = path.join(os.homedir(), ".cache", "extension-js");
const CACHE_FILE = path.join(CACHE_DIR, "templates-meta.json");
const CACHE_TTL_MS = 60 * 60 * 1000;

function isCacheValid(): boolean {
  try {
    const stat = fs.statSync(CACHE_FILE);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

export async function fetchTemplatesMeta(): Promise<TemplatesMetaV2> {
  if (isCacheValid()) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return cached as TemplatesMetaV2;
  }

  let lastStatus = 0;
  for (const url of await templateMetaUrls()) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastStatus = response.status;
        continue;
      }
      const data = (await response.json()) as TemplatesMetaV2;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
      return data;
    } catch {
      // Try the next source.
    }
  }

  if (fs.existsSync(CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as TemplatesMetaV2;
  }
  throw new Error(
    `Failed to fetch templates-meta.json (${lastStatus || "network error"}).`,
  );
}

export interface TemplateFilters {
  surface?: string;
  framework?: string;
  tags?: string[];
  featured?: boolean;
  query?: string;
}

export async function listTemplates(
  filters?: TemplateFilters,
): Promise<TemplateMeta[]> {
  const meta = await fetchTemplatesMeta();
  let templates = meta.templates;

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
