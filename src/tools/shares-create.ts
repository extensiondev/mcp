// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spendNarration } from "../lib/allowance";
import { ZIP_URL_REDIRECT_NOTE } from "../lib/artifacts-api";
import { envelope } from "../lib/envelope";
import { platformHoldEnvelope } from "../lib/platform-hold";
import { uploadPreview } from "../lib/preview-upload";
import {
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
} from "../lib/project-api";
import { fetchRegistryBytes, registryBase } from "../lib/registry";
import { unpackZip } from "../lib/zip-entries";

const COMMAND = "extension_shares";
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 2_000;

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure(status: string, name: string, message: string, value: Row, code: "E_BAD_REQUEST" | "E_PLATFORM" | "E_BUILD_NOT_FOUND" = "E_PLATFORM"): string {
  return envelope({ ok: false, command: COMMAND, status, value, error: { code, name, message } });
}

function isPackage(row: Row): boolean {
  return text(row.type) === "Extension package" || /-extension\.zip$/i.test(text(row.name));
}

/* @invariant A BUILD'S ZIP IS READ FROM THE REGISTRY OF THE SERVER THE CALL
 * NAMES. The artifact list names a download URL, and its host is the
 * platform's idea of a public registry, which a local or self-hosted server
 * may not serve and which would receive this project's access grant. So only
 * the path below <workspace>/<project>/builds/ is kept, and it is read from
 * the registry this server's own reads use.
 */
function packageUrl(api: ProjectApi, downloadUrl: string, apiHint?: string): string | null {
  let pathname: string;

  try {
    pathname = new URL(downloadUrl).pathname;
  } catch {
    return null;
  }

  const marker = `/${encodeURIComponent(api.ref.workspace)}/${encodeURIComponent(api.ref.project)}/builds/`;
  const at = pathname.toLowerCase().indexOf(marker.toLowerCase());

  return at < 0 ? null : `${registryBase(apiHint)}${pathname.slice(at)}`;
}

export async function createShareFromBuild(args: {
  buildId?: string;
  browser?: string;
  project?: string;
  api?: string;
}): Promise<string> {
  const buildId = text(args.buildId);
  const browser = text(args.browser).toLowerCase() || "chrome";
  const value: Row = { action: "create", buildId, browser };

  if (!buildId) {
    return failure(
      "bad-request",
      "SharesInputError",
      'action:"create" needs a buildId, the build to share. extension_builds (action: "list") lists the recent builds. Nothing was uploaded.',
      value,
      "E_BAD_REQUEST",
    );
  }

  const opened = await openProjectApi({ command: COMMAND, project: args.project, api: args.api });
  if (!opened.ok) return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Shares", value });

  const api = opened.api;
  const listed = await projectApiGet<unknown[]>(api, `builds/${encodeURIComponent(buildId)}/artifacts`);

  if (!listed.ok) {
    return projectApiReadFailure(COMMAND, listed, { api: args.api, name: "Shares", value, notFound: "build" });
  }

  const packages = (Array.isArray(listed.json) ? listed.json : []).filter(isRow).filter(isPackage);
  const chosen = packages.find((row) => text(row.browser).toLowerCase() === browser);

  if (!chosen) {
    const has = packages.map((row) => text(row.browser)).filter(Boolean);

    return failure(
      "not-found",
      "SharesBuildPackageMissing",
      `Build ${buildId} has no ${browser} package to share${has.length ? `; it has ${has.join(", ")}` : ", and no package for any browser yet"}. Nothing was uploaded.`,
      value,
      "E_BUILD_NOT_FOUND",
    );
  }

  const url = packageUrl(api, text(chosen.downloadUrl), args.api);

  if (!url) {
    return failure("unavailable", "SharesBuildPackageUnreadable", `The platform named no registry path for build ${buildId}'s ${browser} package (${text(chosen.downloadUrl) || "no URL"}). Nothing was uploaded.`, value);
  }

  const download = await fetchRegistryBytes(url, { ref: api.ref, api: args.api, maxBytes: MAX_DOWNLOAD_BYTES });

  if (!download.ok) {
    if (download.held) {
      return platformHoldEnvelope({ command: COMMAND, name: "SharesHeld", body: download.body, api: args.api, value });
    }

    return failure("unavailable", "SharesBuildDownloadFailed", `Build ${buildId}'s ${browser} package could not be downloaded: ${download.message}. Nothing was uploaded.`, value);
  }

  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-share-build-"));

  try {
    const unpacked = unpackZip(download.bytes, distDir, { maxEntries: MAX_ENTRIES, maxBytes: MAX_UNPACKED_BYTES });

    if (!unpacked.ok) {
      return failure("share-failed", "SharesBuildPackageRefused", `Build ${buildId}'s ${browser} package was refused: ${unpacked.message}. Nothing was uploaded.`, value);
    }

    let manifest: Row;

    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"));
      manifest = isRow(parsed) ? parsed : {};
    } catch {
      return failure("share-failed", "SharesBuildManifestMissing", `Build ${buildId}'s ${browser} package has no readable manifest.json at its root. Nothing was uploaded.`, value);
    }

    const uploaded = await uploadPreview({ distDir, manifest, browser, api: args.api, token: api.token, command: COMMAND });

    if (!uploaded.ok) {
      if (uploaded.held) {
        return platformHoldEnvelope({ command: COMMAND, name: "SharesHeld", body: uploaded.body, api: args.api, value });
      }

      return failure("share-failed", uploaded.error.name, uploaded.error.message, value);
    }

    const share = uploaded.data;

    return envelope({
      ok: true,
      command: COMMAND,
      status: "shared",
      value: {
        ...value,
        project: `${api.ref.workspace}/${api.ref.project}`,
        artifactId: share.artifactId,
        previewUrl: share.previewUrl,
        ...(share.zipUrl ? { zipUrl: share.zipUrl } : {}),
        ...(share.revokeUrl ? { revokeUrl: share.revokeUrl } : {}),
        ...(share.expiresAt ? { expiresAt: share.expiresAt } : {}),
        serves: "platform-build",
        files: unpacked.files,
        allowance: spendNarration({ what: "This share upload", body: uploaded.body }),
      },
      hint: `Anyone with previewUrl can open build ${buildId} for ${browser} in the emulator, with no install or sign-in, and download it as a zip from zipUrl, so the link hands over the built code. It stays live until expiresAt. Run extension_shares (action: "list") to find it again, or action:"revoke" with its artifactId to pull it back.${share.zipUrl ? ` ${ZIP_URL_REDIRECT_NOTE}` : ""}`,
    });
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}
