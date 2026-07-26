// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { getTemplateBySlug } from "../lib/templates-cache";
import {
  stripTemplatePathPrefix,
  templateFileUrls,
} from "../lib/template-artifact-source";

export async function readTemplateSource(args: {
  slug: string;
  files?: string[];
}): Promise<string> {
  const template = await getTemplateBySlug(args.slug);

  if (!template) {
    return JSON.stringify({
      error: `Template '${args.slug}' not found in the catalog`,
      hint: 'Use extension_templates with action: "list" to see available templates.',
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
      files: template.files.map((f) =>
        stripTemplatePathPrefix(template.slug, f),
      ),
      hint: "Pass specific file paths in the files parameter to read their contents.",
    });
  }

  const fileContents: Record<string, string> = {};
  const errors: string[] = [];

  await Promise.all(
    args.files.map(async (filePath) => {
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
