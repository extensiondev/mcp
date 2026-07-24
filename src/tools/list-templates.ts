// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { listTemplates } from "../lib/templates-cache";

export const schema = {
  name: "extension_list_templates",
  description:
    "List available extension templates from the extension.dev template catalog. Filter by surface, framework, or tags. Returns structured metadata from templates-meta.json. Note: 'framework' is the UI framework only (react/vue/svelte/preact/vanilla) - it is not the language. TypeScript and JavaScript templates live under slugs (e.g. 'typescript', 'content-typescript'); shadcn is a React variant ('sidebar-shadcn') and provider AIs are tagged 'ai' ('ai-chatgpt', 'ai-claude'). Reach those with query/tags/slug, not framework.",
  inputSchema: {
    type: "object" as const,
    properties: {
      surface: {
        type: "string",
        enum: ["content", "sidebar", "newtab", "background"],
        description:
          "Filter by extension surface type. For a popup/action starter use the 'action' slug (query:'action'), not a surface filter.",
      },
      framework: {
        type: "string",
        enum: ["react", "vue", "svelte", "preact", ""],
        description:
          "Filter by UI framework only (empty string = vanilla JS). Not a language filter - for TypeScript/JavaScript use query or slug.",
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
          "Keyword search across slug, description, tags, and useCases. Ranks by how many query words match, so a natural phrase works; single keywords are fine too.",
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
