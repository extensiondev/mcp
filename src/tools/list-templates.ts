// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { listTemplates } from "../lib/templates-cache";

export async function searchTemplates(args: {
  surface?: string;
  framework?: string;
  tags?: string[];
  featured?: boolean;
  query?: string;
}): Promise<string> {
  const templates = await listTemplates(args);

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
    downloads: t.downloads,
  }));

  return JSON.stringify({ count: results.length, templates: results });
}
