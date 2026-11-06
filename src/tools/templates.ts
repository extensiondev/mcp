// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { searchTemplates } from "./list-templates";
import { readTemplateSource } from "./get-template-source";
import { envelope } from "../lib/envelope";

export const schema = {
  name: "extension_templates",
  description:
    "Browse the template catalog or read a template's files. TypeScript is slug 'typescript', shadcn 'sidebar-shadcn'; AI templates tag 'ai'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "source"],
        default: "list",
        description: "list searches; source reads one template's files.",
      },
      slug: {
        type: "string",
        description:
          "source: the template, e.g. 'content-react'.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "source: paths to read; omit for the listing.",
      },
      query: {
        type: "string",
        description:
          "list: keywords or a natural phrase.",
      },
      surface: {
        type: "string",
        enum: ["content", "sidebar", "newtab", "background"],
        description:
          "list: surface; for a popup use query:'action'.",
      },
      framework: {
        type: "string",
        enum: ["react", "vue", "svelte", "preact", ""],
        description: "list: UI framework; empty string is vanilla.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "list: tags, e.g. ['ai'].",
      },
      featured: {
        type: "boolean",
        description: "list: featured only.",
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
      return envelope({
        ok: false,
        command: "extension_templates",
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          message: "action 'source' needs a slug.",
        },
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
