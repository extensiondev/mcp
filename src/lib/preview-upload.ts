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

type FetchImpl = typeof fetch;

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "__MACOSX",
]);

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
  | { ok: true; data: PreviewUploadResult }
  | { ok: false; error: { name: string; message: string } };

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
      const relative = path.relative(distDir, absolute).split(path.sep).join("/");
      const bytes = fs.readFileSync(absolute);
      const encoding: "utf8" | "base64" = TEXTUAL.test(relative)
        ? "utf8"
        : "base64";
      files.push({
        path: relative,
        content: bytes.toString(encoding),
        encoding,
      });
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

  const apiCheck = safeApiBase(resolveApiBase(options.api));
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
    return {
      ok: false,
      error: {
        name: "PreviewTooLargeError",
        message: `${options.distDir} is too large to share (over ${Math.floor(
          MAX_CONTENT_CHARS / (1024 * 1024),
        )}MB). Build without source maps, or trim the bundled assets.`,
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
    data: {
      artifactId,
      previewUrl,
      zipUrl: typeof data.zipUrl === "string" ? data.zipUrl : undefined,
      revokeUrl: typeof data.revokeUrl === "string" ? data.revokeUrl : undefined,
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
    },
  };
}
