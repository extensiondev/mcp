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
  templateCatalogUrl,
  templateFileTree,
  templateFileUrls,
  resolvedTemplateCommit,
} from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_templates";

const SCAFFOLDING_FILES = ["template.meta.json", "template.spec.ts", "screenshot.png"];

const TEXTUAL =
  /\.(json|js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|sass|less|svg|txt|md|map|vue|svelte|ya?ml)$/i;

function encodeTemplateFile(
  filePath: string,
  bytes: Buffer,
): { content: string; encoding: "utf8" | "base64" } {
  if (TEXTUAL.test(filePath)) {
    const text = bytes.toString("utf8");

    if (Buffer.from(text, "utf8").equals(bytes)) {
      return { content: text, encoding: "utf8" };
    }
  }

  return { content: bytes.toString("base64"), encoding: "base64" };
}

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
      hint: 'Use extension_templates with action: "list" to see available templates. The catalog this server read may be a cached or bundled copy that predates a rename; the list answer names its source.',
    });
  }

  const sourceCommit = await resolvedTemplateCommit();
  const meta = {
    slug: template.slug,
    sourceCommit,
    description: template.description,
    uiFramework: template.uiFramework || "vanilla",
    surfaces: template.surfaces,
    permissions: template.permissions,
    patternExplanation: template.patternExplanation,
    keyFiles: template.keyFiles,
    repositoryUrl: template.repositoryUrl,
    catalogUrl: templateCatalogUrl(template.slug),
  };

  if (!args.files?.length) {
    const tree = await templateFileTree(template.slug);
    const catalogFiles = [
      ...template.files.map((f) => stripTemplatePathPrefix(template.slug, f)),
      ...(template.configFiles ?? []),
    ];
    const files = tree ?? [...new Set(catalogFiles)].sort();
    const scaffolding = SCAFFOLDING_FILES.filter((name) => files.includes(name));

    return envelope({
      ok: true,
      command: COMMAND,
      status: "file-list",
      value: {
        ...meta,
        filesSource: tree ? "tree" : "catalog",
        files,
      },
      hint: [
        tree
          ? `Every file of the template at sourceCommit. Pass specific file paths in the files parameter to read their contents.`
          : "Pass specific file paths in the files parameter to read their contents.",
        ...(scaffolding.length
          ? [`${scaffolding.join(", ")} ${scaffolding.length === 1 ? "is" : "are"} catalog scaffolding that extension_create does not copy into a project.`]
          : []),
      ].join(" "),
      warnings: tree
        ? []
        : [
            "The template's file tree could not be read from GitHub, so this listing is the catalog's: it names the source and config files and leaves out root files such as package.json, README.md and STORE.md, which the files parameter can still read.",
          ],
    });
  }

  const fileContents: Record<string, string> = {};
  const fileEncodings: Record<string, "utf8" | "base64"> = {};
  const errors: string[] = [];

  await Promise.all(
    args.files.map(async (filePath) => {
      const urls = await templateFileUrls(args.slug, filePath);
      let lastStatus = 0;

      for (const url of urls) {
        try {
          const response = await fetch(url);

          if (response.ok) {
            const encoded = encodeTemplateFile(
              filePath,
              Buffer.from(await response.arrayBuffer()),
            );
            fileContents[filePath] = encoded.content;
            fileEncodings[filePath] = encoded.encoding;

            return;
          }

          lastStatus = response.status;
        } catch {
        }
      }

      errors.push(`${filePath}: ${lastStatus || "fetch failed"}`);
    }),
  );

  const encodedFiles = Object.keys(fileEncodings)
    .filter((filePath) => fileEncodings[filePath] === "base64")
    .sort();

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
      fileEncodings,
    },
    hint: encodedFiles.length
      ? `Base64-encoded, not text: ${encodedFiles.join(", ")}. Decode before writing to disk. fileEncodings names the encoding of every file read.`
      : undefined,
    warnings: errors,
  });
}
