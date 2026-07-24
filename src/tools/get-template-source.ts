// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { getTemplateBySlug } from "../lib/templates-cache";
import { templateFileUrls } from "../lib/template-artifact-source";

export const schema = {
  name: "extension_get_template_source",
  description:
    "Read source files from a template in the extension.dev template catalog. Use this to learn implementation patterns before building something similar.",
  inputSchema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "Template slug (e.g. 'ai-claude', 'content-react')",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific files to read (e.g. ['src/manifest.json', 'src/background.ts']). If omitted, returns the file listing from templates-meta.json.",
      },
    },
    required: ["slug"],
  },
};

export async function handler(args: {
  slug: string;
  files?: string[];
}): Promise<string> {
  const template = await getTemplateBySlug(args.slug);

  if (!template) {
    return JSON.stringify({
      error: `Template '${args.slug}' not found in the catalog`,
      hint: "Use extension_list_templates to see available templates.",
    });
  }

  const meta = {
    slug: template.slug,
    description: template.description,
    uiFramework: template.uiFramework || "vanilla",
    surfaces: template.surfaces,
    permissions: template.permissions,
    patternExplanation: template.patternExplanation,
    keyFiles: template.keyFiles,
    repositoryUrl: template.repositoryUrl,
  };

  if (!args.files?.length) {
    return JSON.stringify({
      ...meta,
      files: template.files,
      hint: "Pass specific file paths in the files parameter to read their contents.",
    });
  }

  const fileContents: Record<string, string> = {};
  const errors: string[] = [];

  await Promise.all(
    args.files.map(async (filePath) => {
      // Media release first, then commit-pinned raw fallback.
      const urls = await templateFileUrls(args.slug, filePath);
      let lastStatus = 0;
      for (const url of urls) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            fileContents[filePath] = await response.text();
            return;
          }
          lastStatus = response.status;
        } catch {
          // Try the next source.
        }
      }
      errors.push(`${filePath}: ${lastStatus || "fetch failed"}`);
    }),
  );

  return JSON.stringify({
    ...meta,
    fileContents,
    ...(errors.length ? { errors } : {}),
  });
}
