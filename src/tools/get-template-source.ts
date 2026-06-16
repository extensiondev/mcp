import { getTemplateBySlug } from "../lib/templates-cache";

const RAW_BASE =
  "https://raw.githubusercontent.com/extension-js/examples/main/examples";

export const schema = {
  name: "extension_get_template_source",
  description:
    "Read source files from a template in the extension.dev template catalog. Use this to learn implementation patterns before building something similar.",
  inputSchema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "Template slug (e.g. 'sidebar-claude', 'content-react')",
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
      const url = `${RAW_BASE}/${args.slug}/${filePath}`;
      try {
        const response = await fetch(url);
        if (response.ok) {
          fileContents[filePath] = await response.text();
        } else {
          errors.push(`${filePath}: ${response.status}`);
        }
      } catch (err) {
        errors.push(
          `${filePath}: ${err instanceof Error ? err.message : "fetch failed"}`,
        );
      }
    }),
  );

  return JSON.stringify({
    ...meta,
    fileContents,
    ...(errors.length ? { errors } : {}),
  });
}
