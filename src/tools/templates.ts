// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { searchTemplates } from "./list-templates";
import { readTemplateSource } from "./get-template-source";

export const schema = {
  name: "extension_templates",
  description:
    "Browse the extension.dev template catalog. Pass action:'list' (the default) to search and filter it and get metadata per template. Pass action:'source' with a `slug` to read one template's files, for learning a pattern before building something similar. Read `framework` as the UI framework only, never the language: TypeScript and JavaScript templates live under slugs ('typescript', 'content-typescript'), shadcn is a React variant ('sidebar-shadcn'), and provider AIs carry the 'ai' tag ('ai-chatgpt', 'ai-claude'). Reach those through query, tags or slug.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "source"],
        default: "list",
      },
      slug: {
        type: "string",
        description:
          "source: which template to read (e.g. 'ai-claude', 'content-react'). Required for source.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "source: paths to read (e.g. ['src/manifest.json']). Omit for the file listing.",
      },
      query: {
        type: "string",
        description:
          "list: keyword search over slug, description, tags and useCases. Ranks by word matches, so a natural phrase works.",
      },
      surface: {
        type: "string",
        enum: ["content", "sidebar", "newtab", "background"],
        description:
          "list: filter by surface. For a popup/action starter use query:'action', not a surface.",
      },
      framework: {
        type: "string",
        enum: ["react", "vue", "svelte", "preact", ""],
        description: "list: UI framework filter (empty string = vanilla JS).",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "list: filter by tags, e.g. ['ai', 'chat'].",
      },
      featured: {
        type: "boolean",
        description: "list: only featured templates.",
      },
    },
    required: [],
  },
};

export async function handler(args: {
  action?: string;
  slug?: string;
  files?: string[];
  query?: string;
  surface?: string;
  framework?: string;
  tags?: string[];
  featured?: boolean;
}): Promise<string> {
  if ((args.action ?? "list") === "source" || (!args.action && args.slug)) {
    if (!args.slug) {
      return JSON.stringify({
        ok: false,
        error: "action 'source' needs a slug.",
        hint: 'Call extension_templates with action: "list" to find one.',
      });
    }
    return readTemplateSource({ slug: args.slug, files: args.files });
  }

  return searchTemplates({
    surface: args.surface,
    framework: args.framework,
    tags: args.tags,
    featured: args.featured,
    query: args.query,
  });
}
