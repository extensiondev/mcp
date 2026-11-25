// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { listTemplatesWithSource } from "../lib/templates-cache";
import { templateCatalogUrl } from "../lib/template-artifact-source";
import { ANSWER_VALUE_CHAR_LIMIT } from "../lib/answer-cap";
import { envelope } from "../lib/envelope";

export async function searchTemplates(args: {
  surface?: string;
  framework?: string;
  tags?: string[];
  featured?: boolean;
  query?: string;
  include?: string[];
  offset?: number;
}): Promise<string> {
  const { templates, source, note } = await listTemplatesWithSource(args);
  const include = Array.isArray(args.include) ? args.include : [];
  const withUrls = include.includes("urls");
  const withDetails = include.includes("details");

  const results = templates.map((t) => ({
    slug: t.slug,
    description: t.description,
    frameworkLabel: t.uiFramework || "vanilla",
    surfaces: t.surfaces,
    ...(withDetails ? { tags: t.tags, difficulty: t.difficulty, featured: t.featured, useCases: t.useCases } : {}),
    ...(withUrls ? { repositoryUrl: t.repositoryUrl, catalogUrl: templateCatalogUrl(t.slug), downloads: t.downloads } : {}),
  }));

  const offset = Math.min(Math.max(0, Math.floor(Number(args.offset) || 0)), results.length);
  const page: typeof results = [];
  let size = JSON.stringify({ count: results.length, offset, source, nextOffset: results.length, templates: [] }).length;

  for (const row of results.slice(offset)) {
    const rowSize = JSON.stringify(row).length + 1;
    if (page.length > 0 && size + rowSize > ANSWER_VALUE_CHAR_LIMIT) break;

    page.push(row);
    size += rowSize;
  }

  const nextOffset = offset + page.length;
  const cut = nextOffset < results.length;

  return envelope({
    ok: true,
    command: "extension_templates",
    status: source === "live" || source === "cache" ? "listed" : "listed-from-fallback",
    value: {
      count: results.length,
      ...(offset > 0 || cut ? { offset } : {}),
      source,
      templates: page,
      ...(cut ? { nextOffset } : {}),
    },
    warnings: note ? [note] : [],
    ...(cut
      ? {
          truncated: true,
          hint: `${page.length} of ${results.length} templates fit in one answer (rows ${offset + 1} to ${nextOffset}). Call extension_templates again with the same arguments and offset: ${nextOffset} for the rest, or narrow with query, surface, framework or fewer include fields.`,
        }
      : {}),
  });
}
