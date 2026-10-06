// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { listTemplatesWithSource } from "../lib/templates-cache";
import { templateCatalogUrl } from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";

export async function searchTemplates(args: {
  surface?: string;
  framework?: string;
  tags?: string[];
  featured?: boolean;
  query?: string;
}): Promise<string> {
  const { templates, source, note } = await listTemplatesWithSource(args);

  const results = templates.map((t) => ({
    slug: t.slug,
    description: t.description,
    uiFramework: t.uiFramework,
    frameworkLabel: t.uiFramework || "vanilla",
    surfaces: t.surfaces,
    tags: t.tags,
    difficulty: t.difficulty,
    featured: t.featured,
    useCases: t.useCases,
    repositoryUrl: t.repositoryUrl,
    catalogUrl: templateCatalogUrl(t.slug),
    downloads: t.downloads,
  }));

  return envelope({
    ok: true,
    command: "extension_templates",
    status: source === "live" || source === "cache" ? "listed" : "listed-from-fallback",
    value: { count: results.length, source, templates: results },
    warnings: note ? [note] : [],
  });
}
