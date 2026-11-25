// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { NO_TOKEN_MESSAGE } from "./credentials";
import { resolveToken } from "./publish";
import { resolveApiBase, safeApiBase } from "./login-flow";
import { bearerHeaders } from "./request-fetch";
import { identityHeaders } from "./session-identity";
import { wwwRevokeUrl } from "./artifacts-api";
import { platformHoldMessage, sawPlatformHold } from "./platform-hold";
import { withoutRedirects } from "./platform-fetch";
import { holdsSecret, isInstallConfig, isSecretFile, SECRET_FOLDERS } from "./source-archive";

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
  leftOut: { secrets: string[] };
}

export interface DistListing {
  files: PreviewUploadFile[];
  leftOut: { secrets: string[] };
}

export type PreviewUploadOutcome =
  | { ok: true; data: PreviewUploadResult; body: unknown }
  | {
      ok: false;
      error: { name: string; message: string };
      held?: boolean;
      body?: unknown;
    };

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

export function collectDistFiles(distDir: string): DistListing {
  const files: PreviewUploadFile[] = [];
  const secrets: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_SEGMENTS.has(entry.name)) continue;

      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;

      const relative = path.relative(distDir, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (SECRET_FOLDERS.includes(entry.name)) {
          secrets.push(`${relative}/`);
          continue;
        }

        walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      if (isSecretFile(entry.name) || isInstallConfig(entry.name)) {
        secrets.push(relative);
        continue;
      }

      const bytes = fs.readFileSync(absolute);

      if (holdsSecret(entry.name, absolute, bytes.length)) {
        secrets.push(relative);
        continue;
      }

      const { content, encoding } = encodeFile(relative, bytes);
      files.push({ path: relative, content, encoding });
    }
  };

  walk(distDir);

  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  return {
    files: files.sort((a, b) => byPath(a.path, b.path)),
    leftOut: { secrets: secrets.sort(byPath) },
  };
}

export async function uploadPreview(options: {
  distDir: string;
  manifest: Record<string, unknown>;
  browser: string;
  api?: string;
  token?: string;
  ref?: { workspace: string; project: string } | null;
  fetchImpl?: FetchImpl;
  command?: string;
}): Promise<PreviewUploadOutcome> {
  const token = options.token ?? resolveToken({ api: options.api });

  if (!token) {
    return {
      ok: false,
      error: {
        name: "PreviewAuthError",
        message: NO_TOKEN_MESSAGE,
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
  let leftOut: { secrets: string[] };

  try {
    ({ files, leftOut } = collectDistFiles(options.distDir));
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
    res = await withoutRedirects(doFetch)(`${apiCheck.base}/api/artifacts`, {
      method: "POST",
      headers: {
        ...bearerHeaders(token, options.ref),
        "content-type": "application/json",
        "x-extensiondev-origin": "mcp",
        ...identityHeaders(options.command ?? "extension_preview_web"),
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
      leftOut,
    },
  };
}
