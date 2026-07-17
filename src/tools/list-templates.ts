// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { listTemplates } from "../lib/templates-cache";

export const schema = {
  name: "extension_list_templates",
  description:
    "List available extension templates from the extension.dev template catalog. Filter by surface, framework, or tags. Returns structured metadata from templates-meta.json.",
  inputSchema: {
    type: "object" as const,
    properties: {
      surface: {
        type: "string",
        enum: [
          "content",
          "sidebar",
          "action",
          "newtab",
          "devtools",
          "options",
          "background",
        ],
        description: "Filter by extension surface type",
      },
      framework: {
        type: "string",
        enum: ["react", "vue", "svelte", "preact", ""],
        description: "Filter by UI framework (empty string = vanilla JS)",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter by tags (e.g. ['ai', 'chat'])",
      },
      featured: {
        type: "boolean",
        description: "Only show featured templates",
      },
      query: {
        type: "string",
        description:
          "Free-text search across slug, description, tags, and useCases",
      },
    },
  },
};

export async function handler(args: {
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
    uiFramework: t.uiFramework || "vanilla",
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
