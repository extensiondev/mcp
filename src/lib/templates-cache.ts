import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TemplatesMetaV2, TemplateMeta } from "./types";

const CACHE_DIR = path.join(os.homedir(), ".cache", "extension-js");
const CACHE_FILE = path.join(CACHE_DIR, "templates-meta.json");
const CACHE_TTL_MS = 60 * 60 * 1000;
const TEMPLATES_META_URL =
  "https://github.com/extension-js/examples/releases/download/nightly/templates-meta.json";

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

  const response = await fetch(TEMPLATES_META_URL);

  if (!response.ok) {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as TemplatesMetaV2;
    }
    throw new Error(`Failed to fetch templates-meta.json: ${response.status}`);
  }

  const data = (await response.json()) as TemplatesMetaV2;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  return data;
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
    const q = filters.query.toLowerCase();
    templates = templates.filter(
      (t) =>
        t.slug.includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags?.some((tag) => tag.includes(q)) ||
        t.useCases?.some((uc) => uc.toLowerCase().includes(q)) ||
        t.aiPromptExamples?.some((ex) => ex.toLowerCase().includes(q)),
    );
  }

  return templates;
}

export async function getTemplateBySlug(
  slug: string,
): Promise<TemplateMeta | undefined> {
  const meta = await fetchTemplatesMeta();
  return meta.templates.find((t) => t.slug === slug);
}
