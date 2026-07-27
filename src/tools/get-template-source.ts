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
import { envelope } from "../lib/envelope";

const COMMAND = "extension_templates";

export async function readTemplateSource(args: {
  slug: string;
  files?: string[];
}): Promise<string> {
  const template = await getTemplateBySlug(args.slug);

  if (!template) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "template-not-found",
      error: {
        code: "E_TEMPLATE_NOT_FOUND",
        message: `Template '${args.slug}' not found in the catalog`,
      },
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
    return envelope({
      ok: true,
      command: COMMAND,
      status: "file-list",
      value: {
        ...meta,
        files: template.files.map((f) =>
          stripTemplatePathPrefix(template.slug, f),
        ),
      },
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

  return envelope({
    ok: errors.length === 0,
    command: COMMAND,
    status: errors.length ? "partial" : "read",
    error: errors.length
      ? {
          code: "E_TEMPLATE_FETCH",
          message: `${errors.length} of ${errors.length + Object.keys(fileContents).length} file(s) could not be read from the template.`,
        }
      : null,
    value: {
      ...meta,
      fileContents,
    },
    warnings: errors,
  });
}
