// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { resolveToken } from "./publish";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { identityHeaders } from "./session-identity";
import { wwwRevokeUrl } from "./artifacts-api";
import { platformHoldMessage, sawPlatformHold } from "./platform-hold";

type FetchImpl = typeof fetch;

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "__MACOSX",
]);

/* @invariant
 * Secrets never ride along into a public share.
 *
 * A share link serves the uploaded bytes to anyone who opens it and offers the
 * whole build as a downloadable zip, so anything a build step copied into
 * dist/ is published the moment it is shared. A stray .env is the common case
 * and the expensive one.
 */
const IGNORED_FILES = /^\.env(\..*)?$|\.(pem|key|p12|pfx|keystore)$/i;

const TEXTUAL = /\.(json|js|mjs|cjs|ts|tsx|jsx|html|htm|css|svg|txt|md|map)$/i;

const MAX_FILES = 2_000;
const MAX_CONTENT_CHARS = 64 * 1024 * 1024;

export interface PreviewUploadFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

export interface PreviewUploadResult {
  artifactId: string;
  previewUrl: string;
  zipUrl?: string;
  revokeUrl?: string;
  expiresAt?: string;
}

export type PreviewUploadOutcome =
  | { ok: true; data: PreviewUploadResult; body: unknown }
  | {
      ok: false;
      error: { name: string; message: string };
      held?: boolean;
      body?: unknown;
    };

/* @invariant
 * A file only travels as text if it survives the round trip byte for byte.
 *
 * Classifying by extension alone is a guess about encoding, and Buffer's utf8
 * conversion answers a failed guess by substituting U+FFFD rather than by
 * failing. The extension list cannot be tightened out of the problem either:
 * ".ts" is TypeScript here and MPEG transport stream elsewhere, and a
 * manifest.json written by a PowerShell redirect is UTF-16. Because the
 * substitution happens before the upload, nothing downstream can undo it, so
 * the check belongs here: re-encode, compare, and fall back to base64 for
 * anything that did not survive.
 */
function encodeFile(
  relativePath: string,
  bytes: Buffer,
): { content: string; encoding: "utf8" | "base64" } {
  if (TEXTUAL.test(relativePath)) {
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").equals(bytes)) {
      return { content: text, encoding: "utf8" };
    }
  }
  return { content: bytes.toString("base64"), encoding: "base64" };
}

export function collectDistFiles(distDir: string): PreviewUploadFile[] {
  const files: PreviewUploadFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_SEGMENTS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORED_FILES.test(entry.name)) continue;
      const relative = path.relative(distDir, absolute).split(path.sep).join("/");
      const bytes = fs.readFileSync(absolute);
      const { content, encoding } = encodeFile(relative, bytes);
      files.push({ path: relative, content, encoding });
    }
  };
  walk(distDir);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function uploadPreview(options: {
  distDir: string;
  manifest: Record<string, unknown>;
  browser: string;
  api?: string;
  token?: string;
  fetchImpl?: FetchImpl;
}): Promise<PreviewUploadOutcome> {
  const token = options.token ?? resolveToken();
  if (!token) {
    return {
      ok: false,
      error: {
        name: "PreviewAuthError",
        message:
          "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
      },
    };
  }

  const apiCheck = safeApiBase(resolveApiBase(options.api), options.api);
  if (!apiCheck.ok) {
    return {
      ok: false,
      error: { name: "PreviewConfigError", message: apiCheck.message },
    };
  }

  let files: PreviewUploadFile[];
  try {
    files = collectDistFiles(options.distDir);
  } catch (err: any) {
    return {
      ok: false,
      error: {
        name: "PreviewReadError",
        message: `Could not read ${options.distDir}: ${err?.message || err}`,
      },
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      error: {
        name: "PreviewEmptyError",
        message: `${options.distDir} has no files to share.`,
      },
    };
  }
  if (files.length > MAX_FILES) {
    return {
      ok: false,
      error: {
        name: "PreviewTooLargeError",
        message: `${options.distDir} has ${files.length} files, over the ${MAX_FILES} allowed in a shared preview.`,
      },
    };
  }
  const totalChars = files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalChars > MAX_CONTENT_CHARS) {
    /* @invariant
     * The number in this message is the budget the caller actually has.
     *
     * The cap counts encoded characters, and binary files are base64, which
     * costs four characters for every three bytes. Quoting the raw cap told
     * someone whose dist is mostly images and fonts that their 50MB build was
     * "over 64MB", and pointed them at source maps that were not what filled
     * the budget. Reporting what was measured, in the units they can act on,
     * is the difference between an actionable limit and an argument.
     */
    const encodedBytes = files.reduce(
      (sum, file) =>
        sum + Buffer.byteLength(file.content, file.encoding),
      0,
    );
    const mb = (value: number) => (value / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: {
        name: "PreviewTooLargeError",
        message:
          `${options.distDir} is too large to share: ${mb(encodedBytes)}MB of files. ` +
          `A shared preview holds about ${mb(
            MAX_CONTENT_CHARS,
          )}MB of text, and roughly ${mb(
            (MAX_CONTENT_CHARS * 3) / 4,
          )}MB when the build is mostly images, fonts or wasm, which travel base64-encoded. ` +
          "Trim the bundled assets, or build without source maps if yours are large.",
      },
    };
  }

  const name =
    typeof options.manifest.name === "string" && options.manifest.name.trim()
      ? (options.manifest.name as string)
      : path.basename(options.distDir);
  const version =
    typeof options.manifest.version === "string"
      ? (options.manifest.version as string)
      : undefined;

  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${apiCheck.base}/api/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-extensiondev-origin": "mcp",
        ...identityHeaders("extension_preview_web"),
      },
      body: JSON.stringify({
        kind: "dist",
        generation: {
          name,
          version,
          browser: options.browser,
          manifestVersion: options.manifest.manifest_version === 2 ? 2 : 3,
          files,
        },
      }),
    });
  } catch (err: any) {
    return {
      ok: false,
      error: {
        name: "PreviewNetworkError",
        message: `Could not reach ${apiCheck.base}/api/artifacts: ${
          err?.message || err
        }`,
      },
    };
  }

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    if (sawPlatformHold(res, data)) {
      return {
        ok: false,
        held: true,
        body: data,
        error: {
          name: "PreviewHeld",
          message: platformHoldMessage(data, options.api),
        },
      };
    }
    return {
      ok: false,
      error: {
        name: "PreviewUploadError",
        message: `Preview upload failed (${res.status}): ${
          (data?.message as string) || text || "unknown error"
        }`,
      },
    };
  }

  const artifactId = typeof data.artifactId === "string" ? data.artifactId : "";
  const previewUrl = typeof data.previewUrl === "string" ? data.previewUrl : "";
  if (!artifactId || !previewUrl) {
    return {
      ok: false,
      error: {
        name: "PreviewUploadError",
        message:
          "The upload succeeded but the platform returned no preview link, so there is nothing to share.",
      },
    };
  }

  return {
    ok: true,
    body: data,
    data: {
      artifactId,
      previewUrl,
      zipUrl: typeof data.zipUrl === "string" ? data.zipUrl : undefined,
      revokeUrl:
        typeof data.revokeUrl === "string"
          ? wwwRevokeUrl(data.revokeUrl)
          : undefined,
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
    },
  };
}
