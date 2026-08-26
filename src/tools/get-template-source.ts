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
  templateFileUrls,
} from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_templates";

const TEXTUAL =
  /\.(json|js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|sass|less|svg|txt|md|map|vue|svelte|ya?ml)$/i;

/* @invariant
 * A template file only travels as text if it survives the round trip.
 *
 * The corpus serves the template icons itself since 2026-08-26, so a request
 * for src/images/icon.png reaches real PNG bytes now instead of a 404. Reading
 * those bytes with response.text() decodes them as utf8 and Buffer answers a
 * failed decode by substituting U+FFFD, so the agent used to receive mojibake
 * that no decoder downstream can undo. Extension alone is a guess about
 * encoding, so the rule is preview-upload's: re-encode, compare, and fall back
 * to base64 for anything that did not survive. fileEncodings names the
 * encoding of every file that was read, so base64 is never mistaken for text.
 */
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
    catalogUrl: templateCatalogUrl(template.slug),
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
          // Try the next source.
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
